# Software design — audit

> **Verdict-first.** This codebase is *mostly* well-designed at the module level — `McpClient` is a textbook deep module, `runAgentLoop` is one function reused by four agents with no duplication, error handling clusters at three intentional boundaries. The load-bearing gap is in the UI band: `app/page.tsx` (817 LOC, 8 concerns, 14 useState slots) is the worst shallow module in the repo and fires #1 on every lens. The highest-priority finding is that one file — extracting three hooks retires the cognitive-load hotspot AND the parser duplication it carries. Two other deliberate fixes ride along: the Insight↔Anomaly silent field-drop (three locations, TypeScript can't catch it) and the duplicated `synthesize()` recovery method (two copies of the same special case the agent loop should own).

---

## complexity-in-this-codebase

Complexity in this codebase has a postal address — the UI/streaming band. Below it (route handlers, agents, MCP wrapper), files are small, calm, and single-purpose. Above the route layer, `app/page.tsx` holds eight independent concerns in one 817-LOC client component: rendering, NDJSON stream parsing, reconnect policy, demo capture, mode toggling, coverage accumulation, trace accumulation, stepper-state derivation. Ousterhout's three symptoms fire here as follows:

- **Change amplification.** Two named instances. The `Insight ↔ Anomaly` mapping lives in three places (`lib/mcp/types.ts` interfaces, `lib/state/insights.ts:8-28` for `anomalyToInsight`, `app/api/agent/route.ts:29-31` for `insightToAnomaly`); the `synthesize()` recovery pattern lives in two (`lib/agents/diagnostic.ts:86-126`, `lib/agents/recommendation.ts:82-132`).
- **Cognitive load.** `app/page.tsx` (817 LOC). Next worst: `lib/hooks/useInvestigation.ts` (216 LOC, NDJSON parser in a hook), `components/feed/InsightCard.tsx` (495 LOC, inline-CSS heavy).
- **Unknown-unknowns.** `filterByStep` in `app/api/agent/route.ts:66-84` reads `AgentEvent` shapes by tag and by a nested `agent` property — add a new event variant to `lib/mcp/events.ts:4-12` and the filter silently drops it from the demo replay.

The diagnostic frame: this codebase isn't "complex." Complexity has an address. The lens names which symptom fires where, and the rest of the audit walks each.

→ see `02-shallow-module-page-component.md` for the deep walk on the cognitive-load hotspot
→ see `03-insight-anomaly-silent-leak.md` for the change-amplification leak
→ see `04-synthesize-recovery-duplication.md` for the duplicated special case

## deep-vs-shallow-modules

Two ends of the depth axis, both extreme.

**Deepest: `lib/mcp/client.ts` (172 LOC, 3 methods).** `McpClient.callTool(name, args, opts?)` returns `{ result, durationMs, fromCache }` and hides six mechanics: TTL cache lookup, spacing gate, live transport call, retry loop with parsed `Retry-After`, error tagging via `McpToolError`, write-back on success only. The caller learns three method signatures; the implementation absorbs the entire MCP-rate-limit reality. Ratio: ~57 LOC of hidden logic per public method. Textbook deep module.

**Second-deepest: `runAgentLoop` (`lib/agents/base.ts:48-176`).** One function, four callers (`MonitoringAgent`, `DiagnosticAgent`, `RecommendationAgent`, `QueryAgent`). Hides the Anthropic tool-use loop, `tool_use` block extraction, `tool_result` feedback, `forceFinal` synthesis trick, tool-call budget enforcement, graceful turn-budget termination. The four agent classes pass a prompt + tool subset + hooks and read `finalText`. Zero duplication of the loop across the four agents.

**Shallowest: `app/page.tsx` (817 LOC).** Exports one component, but the JSX reads from 14 `useState` slots and the file holds eight concerns at one altitude. Interface ≈ implementation — nothing is hidden. The whole file IS the surface.

**Honorable mentions:** `coverageFor` + `coverageReport` in `lib/agents/categories.ts` (pure schema gate, three exported functions, fat body); `McpCaller` interface in `lib/agents/base.ts:16-22` (one method, hides whether `McpClient` or a test fake satisfies it).

→ see `01-mcp-client-deep-module.md` for the deep walk on what makes the deepest module deep
→ see `02-shallow-module-page-component.md` for the deep walk on the worst shallow module

## information-hiding-and-leakage

Strong hides and one severe leak.

**Strong hides (praise):**
- `lib/mcp/client.ts:31-38` — the `parseRetryAfterMs` helper owns the Bloomreach rate-limit error grammar. Two prose formats observed ("Retry after ~N second", "rate limit reached (1 per N second)"), one regex, one file. Grep the repo for `/retry-after/` and only this file matches. That's the test: search for the secret, count files.
- `lib/agents/base.ts:48-176` — `runAgentLoop` owns the Anthropic tool-use protocol. The four agent classes never touch `ToolUseBlock`, never construct `tool_result` blocks, never know about content-array shape.
- `lib/mcp/auth.ts:33-143` — three OAuth storage backends (file in dev, memory in test, encrypted cookie in prod) selected internally on `NODE_ENV`. Callers see `BloomreachAuthProvider` and never know which backend is active. The `NODE_ENV` check IS the secret, encapsulated. Hiding, not leakage.

**The worst leak:** the Insight↔Anomaly field-copy list, encoded in three places. `lib/mcp/types.ts` holds the interfaces (truth source); `lib/state/insights.ts:8-28` (`anomalyToInsight`) copies 8 fields; `app/api/agent/route.ts:29-31` (`insightToAnomaly`) copies 4 of those 8 and silently drops `evidence`, `impact`, `history`, `category`. Add a new field to `Anomaly` and TypeScript catches case (1) but not cases (2) or (3) — the round-trip silently loses data.

**Second leak:** `synthesize()` recovery duplicated across `lib/agents/diagnostic.ts:86-126` and `lib/agents/recommendation.ts:82-132`. Same shape — serialize tool-call history, run a tool-less Anthropic call with recovery prompt, parse result, return null on failure. Two files own one decision.

→ see `03-insight-anomaly-silent-leak.md` for the deep walk on the worst leak
→ see `04-synthesize-recovery-duplication.md` for the duplicated recovery
→ see `01-mcp-client-deep-module.md` for the strong-hide example (`parseRetryAfterMs`)

## layers-and-abstractions

Mostly transforming, one literal pass-through.

The repo has four real layers (UI → route → agent → MCP wrapper → transport) and most boundaries transform what passes through them: routes add NDJSON framing + cache-replay; agents add prompts + tool subsets + validation; `McpClient.callTool` adds five things (cache lookup, spacing, retry, duration timing, cache write). `MonitoringAgent.scan` (`lib/agents/monitoring.ts:69-120`) adds six transforms between the route's `hooks + categories` input and the validated/sorted/sliced `Anomaly[]` output.

**The one literal pass-through:** `McpClient.listTools` (`lib/mcp/client.ts:168-171`) — one line: `return this.transport.listTools()`. No cache, no spacing, no retry. The comment above the method documents the deliberate absence (the tool list is read once at startup; it doesn't count against the rate limit; failures here are fatal anyway). It stays — the justification is "single-import surface for the MCP domain," and that's a real reason. But it's the only pass-through in the codebase and a reviewer is right to ask why.

**Soft pass-through-shaped finding:** the four agent classes (`MonitoringAgent`, `DiagnosticAgent`, `RecommendationAgent`, `QueryAgent`) each have a constructor taking the same four args and one public method. Each method does real work (prompt build → loop → parse → validate → sort/slice), so it's not a pass-through — but the constructor-plus-one-method shape would fit functions just as well. Judge call: keep as classes; the constructor-once pattern beats functions-with-shared-options-bag at this size.

## pull-complexity-downward

Mostly healthy.

`McpClient`'s constructor defaults every knob (`minIntervalMs?: 200`, `maxRetries?: 3`, `retryDelayMs?: 10_000`, `retryCeilingMs?: 20_000`). Production overrides once at construction in `lib/mcp/connect.ts:89-96` (`minIntervalMs: 1100` because the prod server runs at ~1 req/s). Per-call code never touches retry strategy.

`runAgentLoop`'s `maxTurns` and `maxToolCalls` ARE pushed up to the four agent classes — correctly. The loop has no idea what role it's running; the agent does (`MonitoringAgent.scan: 6`, `DiagnosticAgent.investigate: 6`, `RecommendationAgent.propose: 4`, `QueryAgent.answer: 6`). Knobs the module couldn't have defaulted.

`cacheTtlMs` and `skipCache` on `callTool` are earned per-call knobs — one caller (`app/api/mcp/call/route.ts`, used by `/debug`) genuinely needs the override.

**The one finding:** the `synthesisInstruction` strings in all four agents share a prefix ("You have NO more tool calls available...") and closer ("Do not say you need more queries"), but the boilerplate is inline-duplicated. The shape-clause middle is genuinely role-specific (JSON array of anomalies vs single JSON object vs JSON array of recommendations vs plain prose); the wrapping isn't. Lift `buildSynthesisInstruction(shape: string)` into `runAgentLoop` and agents pass only the shape. Partial pull-down — only what the loop has info to own.

## errors-and-special-cases

Strongest design facet in the codebase. Three intentional error boundaries:

- **`McpClient`** masks rate-limit errors via parsed retry-after (`lib/mcp/client.ts:121-132`) — silent retry, caller sees no exception, same return shape as first-try success. Transforms transport failures into `McpToolError(toolName, detail)` so the UI shows "list_projects → invalid_token" instead of generic "Unauthorized."
- **`runAgentLoop`** catches each `mcp.callTool` and feeds failures back as `is_error: true` tool_result (`lib/agents/base.ts:140-168`). One bad tool doesn't kill the run; the model can react.
- **Agent classes** mask parse/validate failures: `return []` or `return FALLBACK`. The route caller writes `const anomalies = await agent.scan(...); const insights = anomalies.map(anomalyToInsight)` — no try/catch needed.

Other layers read error-free. NDJSON consumers in `app/page.tsx:450-456` and `lib/hooks/useInvestigation.ts:193-200` swallow malformed lines silently (correct for streamed NDJSON across HTTP).

**The one finding (a special case to define out):** the "agent emitted no parseable JSON" recovery is handled with a dedicated `synthesize()` method in both `DiagnosticAgent` (`lib/agents/diagnostic.ts:86-126`) and `RecommendationAgent` (`lib/agents/recommendation.ts:82-132`). Two ~50-line copies of the same shape. The fix is to lift the recovery into `runAgentLoop` itself as `parseResult: (text) => T | null` + `recoveryPrompt: (toolCalls) => string` options — the loop runs as normal, attempts to parse, runs ONE recovery turn on failure. Both `synthesize()` methods delete.

→ see `04-synthesize-recovery-duplication.md` for the define-it-out fix

## readability (names · comments · consistency · obviousness)

Strong overall, with one consistency drift.

**Names (strong, 2 nits).** Most names are precise: `anomaly`, `diagnosis`, `schemaCapabilities`, `parseRetryAfterMs`, `forceFinal`, `synthesisInstruction`, `McpToolError`. Two outliers, both in `lib/insights/derive.ts`: `r` at L13 (`const r = e?.result as ...`, should be `result`) and `cp` at L29 (`const cp = findCurrentPrior(...)`, should be `period`). Easy renames.

**Comments (strongest facet — load-bearing throughout `lib/`).** The 6-line comment above `minIntervalMs: 1100` in `lib/mcp/connect.ts:82-88` is the canonical example — it carries the constraint (Bloomreach 1 per N seconds), the math (1100 not 10000 — budget calculation), the related logic location (McpClient retry parsing + cache), the consequence of changing it (route budget blown). The code below is one literal. The comment IS the design. Same pattern across `lib/mcp/auth.ts:21-34` (the three-backend selection), the `LIVE-VERIFICATION` block at the top of `connect.ts`, the step-split rationale in `app/api/agent/route.ts:24-28`.

**Consistency (one drift).** Styling in components. The codebase has Tailwind v4 installed AND uses inline `style={{...}}` with CSS variables. `components/feed/InsightCard.tsx` (495 LOC) has ~150 inline style objects mixed with occasional `className=` uses. No stated rule for which to use where. Small fix: pull repeated style objects into named `CSSProperties` constants per component (`cardStyle`, `tileStyle`) so the JSX reads as JSX. The pattern already exists in `components/investigation/EvidencePanel.tsx:13-46`.

**Obviousness (strong, one deliberate surprise).** `useInvestigation` (`lib/hooks/useInvestigation.ts:43-48`) intentionally does NOT clean up its fetch on effect unmount. The comment at L31-L36 documents why (React StrictMode mount-clean-remount aborted the stream and emptied the logs; the started-guard prevents double-fetch). Surprise justified, comment carries the WHY.

## red-flags-audit

The 12 AOSD red flags scored for this codebase, ranked by severity for the next contributor:

```
FIRES (ranked)
  #1  shallow module                CRITICAL  app/page.tsx (817 LOC, 8 concerns)
  #2  information leakage           HIGH      Insight↔Anomaly field-copy in 3 files
  #3  special-case sprawl           HIGH      synthesize() in diagnostic + recommendation
  #4  convention drift              MEDIUM    inline-CSS vs Tailwind across components
  #5  partially-pushed-up config    MEDIUM    synthesisInstruction boilerplate ×4
  #6  pass-through method           LOW       McpClient.listTools (earned — keep)
  #7  vague names                   LOW       `r`, `cp` in lib/insights/derive.ts

DOESN'T FIRE (praise)
  - classitis              4 agent classes earn their keep
  - try/catch sprawl       errors masked at 3 intentional boundaries
  - comment restates code  comments load-bearing throughout lib/
  - hard-to-read names     >95% of names are precise

N/A (codebase too small/uniform)
  - temporal decomposition  the synthesize() duplication is mild instance
  - exposed-knob sprawl     knobs well-defaulted; one earned per-call knob
```

5 of 7 fires concentrate in two places — `app/page.tsx` (fires #1, contributes to #4) and the agent classes (fire #3, #5, contribute to #4 via their UI counterparts). That clustering is itself a finding: the cleanup work has two natural fronts, not seven scattered tasks.

→ see `02-shallow-module-page-component.md` for #1
→ see `03-insight-anomaly-silent-leak.md` for #2
→ see `04-synthesize-recovery-duplication.md` for #3 and #5

---

## Top 3 ranked findings

1. **Extract three hooks from `app/page.tsx`** — `app/page.tsx:1-817` — `useBriefingStream(mode)`, `useReconnectPolicy()`, `useDemoCapture(insights, workspace, trace)`; page collapses to ~120 LOC of layout + composition. Retires the cognitive-load hotspot AND the NDJSON parser duplication (`useInvestigation` shares the parser).

2. **Colocate `insightToAnomaly` with `anomalyToInsight`** — `app/api/agent/route.ts:29-31` → `lib/state/insights.ts`. Add a round-trip test asserting no field loss. Deeper fix: change the wire format so `/api/agent` accepts only the insight id and looks up the cached anomaly server-side — retires the leak entirely.

3. **Lift `synthesize()` into `runAgentLoop`** — `lib/agents/diagnostic.ts:86-126` + `lib/agents/recommendation.ts:82-132`. Add `parseResult` + `recoveryPrompt` options to `runAgentLoop`; the loop runs as normal, attempts the parse, runs ONE tool-less recovery turn on failure. Both `synthesize()` methods delete (~90 LOC removed).
