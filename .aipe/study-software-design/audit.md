# Software design — audit

> **Verdict-first.** This codebase is well-designed at the module level. Three top findings from the 2026-06-02 audit (page.tsx shallow module, Insight↔Anomaly leak, duplicated `synthesize()`) have **all landed** between 2026-06-02 and 2026-06-15 and are now RESOLVED. In their place, Phase 2 added a new textbook **deep module** — the `DataSource` seam in `lib/data-source/` (~73-LOC interface, two adapter implementations of ~214 and ~197 LOC, factory hiding bootstrap/OAuth/subprocess/mode-switching) — and a **special-purpose vs general-purpose interface** trade-off worth naming: the `mcp-server-olist/` sibling package ships three domain tools (`get_metric_timeseries`, `get_segments`, `get_anomaly_context`) instead of one general `execute_sql`. The remaining live findings are smaller: the lingering inline-CSS/Tailwind drift in `InsightCard`, the `synthesisInstruction` boilerplate ×4, and two vague names in `lib/insights/derive.ts`. The biggest open verdict is now an **honest trade-off, not a debt**: keeping `lib/mcp/client.ts` as a 17-line shim re-exporting from `lib/data-source/` instead of deleting it and renaming 16 test imports. That's "don't break existing seams when the cost of doing so exceeds the cost of keeping them," applied at the cleanup level.

---

## complexity-in-this-codebase

Complexity in this codebase had a postal address — the UI/streaming band. The three biggest finds from the 2026-06-02 audit have all landed since: `app/page.tsx` shrank from 817 → 462 LOC after the three-hook extraction; `insightToAnomaly` was colocated with its inverse in `lib/state/insights.ts:25-55`; the duplicated `synthesize()` was lifted into `runAgentLoop` as `parseResult` + `recoveryPrompt` params. Ousterhout's three symptoms now fire as follows:

- **Change amplification.** Down from two instances to one mild one. The `Insight↔Anomaly` round-trip is colocated (and the dropped fields are now an intentional, commented choice — see `lib/state/insights.ts:47-55`). The `synthesisInstruction` boilerplate strings still repeat across the four agent classes (the shared "you have NO more tool calls" prefix + closer), a partial pull-down opportunity. Smallest live amplification: the eval suite's `eval/scripts/run-*.ts` files share a result-dir + judges-load pattern; they're outside `npm test` and the symmetry is deliberate, not a smell.
- **Cognitive load.** `app/page.tsx` (462 LOC, was 817). Next worst: `lib/hooks/useInvestigation.ts` (199 LOC, NDJSON parser in a hook — the proof-of-concept the page hook copy applied), `components/feed/InsightCard.tsx` (495 LOC, inline-CSS heavy — the remaining concrete debt in the UI band).
- **Unknown-unknowns.** `filterByStep` in `app/api/agent/route.ts` still reads `AgentEvent` shapes by tag and by a nested `agent` property — add a new event variant to `lib/mcp/events.ts:4-12` and the filter silently drops it from the demo replay. **PR G's eval suite now guards a sibling case**: `eval/scripts/run-detection.ts` refuses to run with `process.exit(1)` when the goldens directory is empty, instead of silently producing a zero-finding pass. That's the same defense pattern (loud failure on empty input) the route's `filterByStep` still lacks.

The diagnostic frame is now smaller: the codebase isn't "complex," and the addresses that were complex have mostly been refactored. The lens names which symptom fires where, the rest of the audit walks each.

→ see `02-shallow-module-page-component.md` for the deep walk on the (now resolved) cognitive-load hotspot — kept as a worked example of how the shallow→deep refactor played out
→ see `03-insight-anomaly-silent-leak.md` for the change-amplification leak (now RESOLVED — kept as the worked example of the colocate-then-test fix)
→ see `04-synthesize-recovery-duplication.md` for the duplicated special case (now RESOLVED — kept as the worked example of "lift to the loop")

## deep-vs-shallow-modules

The depth axis still bites — the deepest module is now the **DataSource seam** (new in Phase 2), and the once-shallowest (`app/page.tsx`) has been pulled into the deep band by a three-hook extraction.

**The new deep canon: the `DataSource` seam (`lib/data-source/`).** `DataSource` is a 72-LOC interface with two methods (`callTool`, `listTools`) and a small result envelope. Behind that surface sit two adapter implementations: `BloomreachDataSource` (214 LOC — cache + ~1 req/s spacing + retry-after grammar + OAuth tagging) and `OlistDataSource` (197 LOC — subprocess spawn + stdio MCP client + abort-signal composition). The factory `makeDataSource(mode, sessionId)` (in `lib/data-source/index.ts`, 113 LOC) absorbs adapter selection, the OAuth-redirect-or-construct branch (Bloomreach), the subprocess-spawn branch (Olist), the schema-bootstrap branch difference, and the dispose semantics difference. Route handlers see one interface and one factory; everything else hides. **Depth ratio: 2 methods + 1 factory function on top, ~600 LOC of adapter mechanics below.** This is the textbook deep-module case study now.

**Deepest single class: `BloomreachDataSource` (214 LOC, 2 methods).** Same depth ratio as the old `McpClient` (the class moved + renamed in PR A of Phase 2; the internals didn't change). Cache lookup, spacing gate, live transport call, retry with parsed `Retry-After`, error tagging, write-on-success only — all behind one `callTool`.

**`runAgentLoop` (`lib/agents/base.ts:1-270`).** One function, four callers. After the Phase 1 `synthesize()` lift, it now also absorbs the structured-output recovery turn — `parseResult` + `recoveryPrompt` parameters mean each agent passes its parser/prompt and the loop owns when to recover. The loop got *deeper* (one more decision absorbed) without widening its surface (just two more optional params). That's the right direction for a deep module — see `04-synthesize-recovery-duplication.md` for the deep walk on that move.

**General-purpose vs special-purpose interface — `mcp-server-olist/`.** The sibling package exposes three domain-shaped tools — `get_metric_timeseries`, `get_segments`, `get_anomaly_context` — instead of one general `execute_sql`. The trade-off is real and worth naming: a single `execute_sql` is the deepest possible interface (one method, infinite reach) but pushes the schema knowledge up to the agent prompt and the SQL safety problem up to runtime. Three named tools narrow the interface to what the monitoring/diagnostic/recommendation flows actually need; the schema knowledge is owned by the server, the agents call typed tools. The judgment: this codebase ships domain tools because the analyst loop is well-bounded (period-over-period on 90d windows) and the safety win (no general SQL surface to the LLM) is worth the wider interface. The package lives as a sibling (not under `lib/`) because the MCP server is the unit of deployment and versioning — its `package.json`, its compiled `dist/`, and its test fixtures are all separate concerns from the Next.js app. Together-or-apart call: apart, because the boundary follows the deploy unit, not just the import graph.

**Shallowest, now resolved: `app/page.tsx` (462 LOC, was 817).** The three-hook extraction landed: `useBriefingStream` (313 LOC), `useDemoCapture` (146 LOC), `useReconnectPolicy` (123 LOC). The page is no longer the shallowest module — it's now a layout-and-composition component with three depth hooks behind it. **`components/feed/InsightCard.tsx` (495 LOC, inline-CSS heavy) is the new shallowest live offender** — not because it spans many concerns, but because its rendering surface is wide (~150 inline `style` objects mixed with the occasional `className`).

**Honorable mentions:** `coverageFor` + `coverageReport` in `lib/agents/categories.ts` (pure schema gate, fat body); the `McpCaller` interface alias (now `DataSource` for new code) preserved at the seam.

→ see `01-mcp-client-deep-module.md` for the historic deep walk (and the post-rename note connecting it to `BloomreachDataSource`)
→ see `02-shallow-module-page-component.md` for the RESOLVED shallow-module verdict, kept as a worked example of the refactor
→ a worked example of the new `DataSource` seam lives inside this audit (no Pass 2 file needed yet — the lens already carries the deep walk; spin off when the seam grows a third adapter)

## information-hiding-and-leakage

Strong hides, two new ones added by Phase 2, both 2026-06-02 leaks now closed.

**Strong hides (praise):**
- `lib/data-source/bloomreach-data-source.ts:57-74` — the `parseRetryAfterMs` helper owns the Bloomreach rate-limit error grammar (moved with the class in PR A; the regex didn't change). Two prose formats observed ("Retry after ~N second", "rate limit reached (1 per N second)"), one file. The grep test still passes — search the repo for `/retry-after/` and only this file matches.
- **NEW — `makeDataSource(mode, sessionId)` in `lib/data-source/index.ts:73-109`.** The factory hides four orthogonal facts from route handlers: which adapter to construct (Bloomreach vs Olist), the OAuth-redirect-or-construct branch (`{ ok: false, authUrl }` propagates from `connectMcp` only when Bloomreach), the subprocess-spawn-and-connect for Olist, and the asymmetric dispose semantics (Olist tears the subprocess down; Bloomreach is session-scoped and no-ops). Route handlers reach for `dsResult.dataSource` and `dsResult.dispose()`; nothing in `/api/agent` or `/api/briefing` knows which adapter is on the wire. **This is the new strongest information-hiding case study in the codebase.**
- **NEW — domain-tool surface in `mcp-server-olist/src/tools/`.** Each of the three tools (`get_metric_timeseries`, `get_segments`, `get_anomaly_context`) owns the SQL it runs and the schema it queries. The agent sees a tool name and a typed input schema; the SQL never crosses the wire. Same hiding shape as `parseRetryAfterMs` — one file knows the grammar (here, the join order on Olist tables); no caller does.
- `lib/agents/base.ts` — `runAgentLoop` owns both the Anthropic tool-use protocol AND the new structured-output recovery (since the `synthesize()` lift). Four agent classes never touch `ToolUseBlock`, never construct `tool_result` blocks, never write a recovery turn.
- `lib/mcp/auth.ts:33-143` — three OAuth storage backends selected internally on `NODE_ENV`. Unchanged since 2026-06-02; still a strong hide.

**RESOLVED — the Insight↔Anomaly field-list leak.** `insightToAnomaly` now lives colocated with `anomalyToInsight` in `lib/state/insights.ts:25-55`. Crucially, the fix wasn't to make the dropped fields copy — it was to *name the drop as intentional* in a load-bearing comment (`lib/state/insights.ts:47-52`: "Reverse mapper. Intentionally drops evidence/impact/history/category — the agent loop only needs metric/scope/change/severity to investigate; the rest is regenerated downstream."). The round-trip test in `test/state/insights.test.ts` asserts the contract. The leak retired; the kept-as-worked-example pattern file (`03-`) is marked RESOLVED.

**RESOLVED — the duplicated `synthesize()` recovery.** Both copies are gone from `lib/agents/diagnostic.ts` and `lib/agents/recommendation.ts`. The strategy lifted into `runAgentLoop` as `parseResult: (text) => T | null` + `recoveryPrompt: (toolCalls) => string` (see `lib/agents/base.ts:65-66` and the recovery turn at `:213-217`). Agents pass their parser + prompt builder; the loop owns when to run the recovery turn. ~90 LOC removed. Kept as the worked example in `04-`.

**New, smaller leak worth naming honestly:** the **session-state shape** is owned in two places. `lib/state/insights.ts:8-12` defines `SessionFeed` ({ insights, investigations, anomalies }) as the canonical type, and the `state` Map at L14 is the only writer. Both `/api/briefing` and `/api/agent` route handlers read this same map directly (not through a façade). It's a small leak — they only read; there's no "two writers drift" failure mode — and centralizing wouldn't pay for itself today. Named for completeness, not for action.

→ see `01-mcp-client-deep-module.md` for the historic strong-hide example (`parseRetryAfterMs`); the same lesson now applies to the DataSource factory
→ see `03-insight-anomaly-silent-leak.md` — RESOLVED; kept as the worked example of the colocate-then-test fix
→ see `04-synthesize-recovery-duplication.md` — RESOLVED; kept as the worked example of the lift-to-loop fix

## layers-and-abstractions

A new layer landed. The request flow now reads:

```
UI → route → agent → DataSource seam → adapter → (Bloomreach MCP server
                                                   | mcp-server-olist subprocess)
```

Phase 2 inserted the `DataSource` seam between the agents and the adapters. Each boundary still transforms — routes add NDJSON framing + factory bootstrap + dispose semantics; agents add prompts + tool subsets + validation; the seam adapter (`BloomreachDataSource` or `OlistDataSource`) adds cache/spacing/retry or subprocess-spawn/stdio.

**The seam earns its place.** Trace one axis (knowledge ownership: who knows which backend is on the wire?) and the answer flips exactly once, at the agent ↔ DataSource boundary. Above it: no module imports `BloomreachDataSource` or `OlistDataSource` directly except the factory. Below it: each adapter is a complete owner of its protocol. Strip the seam out and every agent class would need a mode switch; with the seam, mode-handling lives in one factory.

**The literal pass-through:** `BloomreachDataSource.listTools` (one line: `return this.transport.listTools()`). No cache, no spacing, no retry — same as in 2026-06-02 (the class moved to `lib/data-source/` but the internals didn't change). Still earns its place for the same reason: tool-list reads happen once at startup, don't count against the rate limit, and failures are fatal anyway.

**`lib/mcp/client.ts` as a 17-line shim — honest trade-off.** The file is now `export { BloomreachDataSource as McpClient, McpToolError, ... } from '../data-source/bloomreach-data-source'`. It would have been cleaner to delete the file and rename 16 test imports. The judgment: 16 test renames cost more than 17 lines of shim, and the migration target (`lib/data-source/`) is the new home that test code can adopt incrementally. This is "don't break existing seams when the cost of doing so exceeds the cost of keeping them," applied at the cleanup level. Worth naming because reviewers will ask why both paths exist.

**Soft pass-through-shaped finding (unchanged):** the four agent classes still have constructor-plus-one-method shape. Keep as classes; the constructor-once pattern still beats functions-with-shared-options-bag at this size.

## pull-complexity-downward

Strongest move from Phase 2 was a *deep* pull-down. The DataSource seam absorbed the entire mode-handling complexity that used to be the caller's job: routes used to construct `McpClient` themselves and run their own `connectMcp` ceremony; now they call `makeDataSource(mode, sessionId)` and read `{ ok, dataSource, bootstrap, dispose }`. **Caller code stayed the same size; the seam absorbed everything that would have grown.** That's the textbook pull-complexity-downward move at the architecture seam, not just at a per-call knob.

**The four other live findings:**

1. `BloomreachDataSource`'s constructor still defaults every knob (`minIntervalMs?: 200`, `maxRetries?: 3`, `retryDelayMs?: 10_000`, `retryCeilingMs?: 20_000`). Production overrides once at construction in `lib/mcp/connect.ts` (`minIntervalMs: 1100`). Per-call code never touches retry strategy. Unchanged.

2. `runAgentLoop`'s `maxTurns` and `maxToolCalls` ARE pushed up to the four agent classes — correctly. The loop has no idea what role it's running. After the `parseResult`/`recoveryPrompt` lift, the loop also owns the recovery decision; the agents still hold the parser + prompt builder (knobs the loop can't default).

3. `cacheTtlMs` and `skipCache` on `BloomreachDataSource.callTool` are earned per-call knobs — `app/api/mcp/call/route.ts` (used by `/debug`) genuinely needs them.

4. **Still live: `synthesisInstruction` boilerplate.** The strings in all four agents share a prefix ("You have NO more tool calls available...") and closer ("Do not say you need more queries"), but the boilerplate is inline-duplicated. The shape-clause middle is genuinely role-specific; the wrapping isn't. Lift `buildSynthesisInstruction(shape: string)` into `runAgentLoop` and agents pass only the shape. Partial pull-down — only what the loop has info to own. This was a finding in 2026-06-02 and remains live.

## errors-and-special-cases

Strongest design facet in the codebase, and got stronger. Four intentional error boundaries now:

- **`BloomreachDataSource`** masks rate-limit errors via parsed retry-after — silent retry, caller sees no exception, same return shape as first-try success. Transforms transport failures into `McpToolError(toolName, detail)`. Unchanged from 2026-06-02.
- **`runAgentLoop`** catches each `mcp.callTool` and feeds failures back as `is_error: true` tool_result. One bad tool doesn't kill the run; the model can react. **PLUS** — after the Phase 1 lift, it now also defines out the "no parseable JSON" recovery: if `parseResult(finalText)` returns null and a `recoveryPrompt` was provided, the loop runs ONE tool-less recovery turn and tries the parser again. The case is defined out of the agent layer entirely. See `lib/agents/base.ts:213-218`.
- **Agent classes** mask parse/validate failures: `return []` or `return FALLBACK`. Route caller never writes a try/catch. Unchanged.
- **NEW: PR G goldens-empty pre-flight (eval suite).** `eval/scripts/run-detection.ts` and siblings refuse to run when the goldens directory is empty: `process.exit(1)` with a loud message. The case ("we shipped a release with zero coverage and nobody noticed") was *defined out of existence* — there's no path through the eval where you silently produce a meaningless pass. Designing the safety in rather than relying on humans to remember is the Ousterhout move; the eval scripts are the second place in the codebase to apply it (after the rate-limit silent-retry).

Other layers read error-free. NDJSON consumers swallow malformed lines silently (correct for streamed NDJSON across HTTP).

**RESOLVED:** the `synthesize()` duplication. Both methods deleted; the recovery lives in `runAgentLoop`. See `04-synthesize-recovery-duplication.md` (kept as worked example).

→ see `04-synthesize-recovery-duplication.md` — RESOLVED, kept as the canonical "define it out" example
→ the eval pre-flight is a smaller-scale instance of the same pattern, applied to infrastructure rather than agent flow — worth naming as the second "design in the safety" case study

## readability (names · comments · consistency · obviousness)

Strong overall. Comments got better with Phase 2; one consistency drift remains.

**Names (strong, 2 nits unchanged).** Most names are precise: `anomaly`, `diagnosis`, `schemaCapabilities`, `parseRetryAfterMs`, `forceFinal`, `synthesisInstruction`, `McpToolError`, `DataSource`, `makeDataSource`, `OlistToolError`. Two outliers still live, both in `lib/insights/derive.ts`: `r` (`const r = e?.result as ...`, should be `result`) and `cp` (`const cp = findCurrentPrior(...)`, should be `period`). Easy renames.

**Comments (strongest facet, got better).** The 6-line comment above `minIntervalMs: 1100` in `lib/mcp/connect.ts` is still the canonical example. New worth-naming addition: every file in `lib/data-source/` opens with a load-bearing header comment that names the seam's purpose, the lifecycle, and (for `bloomreach-data-source.ts`) the history of the rename. `lib/state/insights.ts:47-52`'s "Intentionally drops evidence/impact/history/category" comment is the canonical example of using a comment to *make a drop intentional* rather than papering over a leak — that's load-bearing because TypeScript can't carry that intent.

**Consistency (one drift, still live).** Styling in `components/feed/InsightCard.tsx` (495 LOC, ~150 inline `style` objects mixed with occasional `className=`). No stated rule for which to use where. Small fix: pull repeated style objects into named `CSSProperties` constants per component. The pattern already exists in `components/investigation/EvidencePanel.tsx`.

**Obviousness (strong, one deliberate surprise).** `useInvestigation` (`lib/hooks/useInvestigation.ts`) intentionally does NOT clean up its fetch on effect unmount. The comment documents why (React StrictMode mount-clean-remount aborted the stream and emptied the logs; the started-guard prevents double-fetch). `useBriefingStream` (the new hook from Phase 1 page decomposition) copied the same discipline. Surprise justified, comment carries the WHY in both places.

## red-flags-audit

The 12 AOSD red flags rescored against the 2026-06-15 codebase. Three of the top four 2026-06-02 fires have RESOLVED.

```
RESOLVED since 2026-06-02
  RES  shallow module                was CRITICAL  app/page.tsx 817→462 LOC + 3 hooks
  RES  information leakage           was HIGH      insightToAnomaly colocated + comment
  RES  special-case sprawl           was HIGH      synthesize() → loop's parseResult/recoveryPrompt

FIRES (ranked, live)
  #1  convention drift              MEDIUM    inline-CSS vs Tailwind in InsightCard
  #2  partially-pushed-up config    MEDIUM    synthesisInstruction boilerplate ×4
  #3  pass-through method           LOW       BloomreachDataSource.listTools (earned — keep)
  #4  vague names                   LOW       `r`, `cp` in lib/insights/derive.ts
  #5  legacy shim                   LOW       lib/mcp/client.ts (17-line shim — earned, see layers)

DOESN'T FIRE (praise, expanded)
  - classitis              4 agent classes earn their keep; DataSource adapters earn theirs
  - try/catch sprawl       errors masked at 4 intentional boundaries (added: PR G pre-flight)
  - comment restates code  comments load-bearing throughout lib/ and lib/data-source/
  - hard-to-read names     >95% of names are precise
  - shallow module         the worst offender refactored; InsightCard is now the new ceiling
                            and it's a single-concern shallowness (rendering), not 8-concern

N/A (codebase too small/uniform — unchanged)
  - temporal decomposition  no real instance after the synthesize() lift
  - exposed-knob sprawl     knobs well-defaulted; per-call overrides earned
```

The fires now scatter, and they're all LOW or MEDIUM. The clustering finding from 2026-06-02 ("5 of 7 fires concentrate in two places") has dissolved — the two concentration points (`page.tsx` and the duplicated agent classes) were exactly what the three top fixes resolved.

→ see `02-shallow-module-page-component.md` — RESOLVED, kept as worked example
→ see `03-insight-anomaly-silent-leak.md` — RESOLVED, kept as worked example
→ see `04-synthesize-recovery-duplication.md` — RESOLVED, kept as worked example

---

## Top 3 ranked findings — 2026-06-02 set ALL RESOLVED

The original three fixes have landed:

1. **RESOLVED — page.tsx three-hook extraction.** Page 817→462 LOC; `useBriefingStream` (313 LOC), `useDemoCapture` (146 LOC), `useReconnectPolicy` (123 LOC) extracted into `lib/hooks/`. Worked example kept in `02-`. The actual LOC came in larger than predicted (page didn't shrink to ~120) because the layout JSX is itself non-trivial — directionally right, calibration off; lesson worth keeping.

2. **RESOLVED — `insightToAnomaly` colocated.** Now lives at `lib/state/insights.ts:53-55` next to its inverse. The fix wasn't to copy the dropped fields — it was to *make the drop intentional* via a load-bearing comment + round-trip test in `test/state/insights.test.ts`. The wire-format-rewrite "deeper fix" deliberately not done; the cheap fix retired the leak.

3. **RESOLVED — `synthesize()` lifted to `runAgentLoop`.** `parseResult` and `recoveryPrompt` options added to the loop (`lib/agents/base.ts:65-66`); the recovery turn lives at `lib/agents/base.ts:213-217`. Both agent-level `synthesize()` methods gone; ~90 LOC removed as estimated.

## Top 3 ranked findings — current set (2026-06-15)

The remaining live debt is much smaller; the top three are all LOW or MEDIUM. Listing in priority order:

1. **Clean up the `InsightCard` styling drift** — `components/feed/InsightCard.tsx` (495 LOC). Pull repeated inline `style={{...}}` objects into named `CSSProperties` constants per section; the pattern is already in `components/investigation/EvidencePanel.tsx`. Single-file fix; reduces the file from "the new shallowest module" to "a long but consistent rendering component."

2. **Lift `buildSynthesisInstruction(shape)` into `runAgentLoop`** — `lib/agents/{monitoring,diagnostic,recommendation,query}.ts` all hardcode the same prefix/closer with role-specific middles. Same play as the `synthesize()` lift, smaller scale. Add a helper that wraps the shape; agents pass only their shape clause.

3. **Rename `r` / `cp` in `lib/insights/derive.ts`** — trivial; `r` → `result`, `cp` → `period`. Mentioned for completeness; not load-bearing.

The audit has effectively converged. Phase 2's main contribution was *not* to add more findings — it was to add two strong design moves (the DataSource seam and the domain-tool MCP server) that the rest of the codebase can lean on. Most future findings will be about how the seam grows, not about fresh debt.

---
Updated: 2026-06-16 — verdict rewritten for the post-Phase-2 state; three 2026-06-02 top fires marked RESOLVED with notes; added DataSource seam (deep-modules + info-hiding), domain-tool special-purpose interface (deep-modules), new layer in layers-and-abstractions diagram, PR G goldens-empty pre-flight (errors-and-special-cases), legacy-shim trade-off named; current top 3 findings are now smaller.
