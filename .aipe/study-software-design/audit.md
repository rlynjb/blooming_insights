# Software design — audit

> **Verdict-first.** This codebase is well-designed at the module level. Three top findings from the 2026-06-02 audit (page.tsx shallow module, Insight↔Anomaly leak, duplicated `synthesize()`) have **all landed** and are RESOLVED. Since the 2026-06-16 refresh, two further design moves dominate the audit. **(1) The `DataSource` seam survived TWO adapter swaps** — Phase 2 added Olist behind it, then PR #8 removed Olist, then PR `c75ec3e` added `SyntheticDataSource` (516 LOC, in-process, deterministic) behind the same interface. The seam IS the lesson; the adapters behind it are interchangeable. The interface itself stayed put through all three changes — that's the property a deep module is supposed to have. **(2) `@aptkit/core@0.3.0` arrived as a reusable agent library** and the four agent classes (monitoring/diagnostic/recommendation/query) shrank to 30–50 LOC instantiate-and-forward shims, with three new 22–45-LOC Blooming-owned adapter classes in `lib/agents/aptkit-adapters.ts` (206 LOC) bridging AptKit's primitive interfaces (`ModelProvider`, `ToolRegistry`, `CapabilityTraceSink`) to Blooming's domain (Anthropic SDK, `DataSource`, NDJSON hooks). **The same APOSD pattern — small interface, fat hidden body — now teaches TWICE in this codebase, at two different scales.** The remaining live findings are small: inline-CSS drift in `InsightCard`, the `synthesisInstruction` boilerplate ×4 (still live in the active `*.ts` agents' AptKit prompts; resolved in `*-legacy.ts`), and two vague names in `lib/insights/derive.ts`. The biggest open trade-off remains keeping `lib/mcp/client.ts` as a 17-line shim re-exporting from `lib/data-source/` instead of deleting it and renaming 16 test imports.

---

## complexity-in-this-codebase

Complexity in this codebase had a postal address — the UI/streaming band. The three biggest finds from the 2026-06-02 audit have all landed since: `app/page.tsx` shrank from 817 → 461 LOC after the three-hook extraction; `insightToAnomaly` was colocated with its inverse in `lib/state/insights.ts:25-55`; the duplicated `synthesize()` was lifted into `runAgentLoop` as `parseResult` + `recoveryPrompt` params (in the now-legacy `base-legacy.ts`). The 2026-06-19 refresh removes a 2026-06-16 complexity address entirely: the `mcp-server-olist/` sibling package and the `eval/` directory were both deleted in PR #8. Olist's subprocess lifecycle, IPC, and goldens harness — gone. Ousterhout's three symptoms now fire as follows:

- **Change amplification.** Down from two instances to one mild one. The `Insight↔Anomaly` round-trip is colocated (and the dropped fields are now an intentional, commented choice — see `lib/state/insights.ts:47-55`). The `synthesisInstruction` boilerplate strings still repeat across the four legacy agent classes' AptKit-equivalent prompt assembly (the shared "you have NO more tool calls" prefix + closer); the lift landed at `lib/agents/base-legacy.ts:230` (`buildSynthesisInstruction(middle)`) which the four `*-legacy.ts` agents now share. The active `*.ts` agents delegate prompt construction to AptKit, so the duplication doesn't reappear at the new path.
- **Cognitive load.** `app/page.tsx` (461 LOC, was 817). Next worst: `lib/hooks/useInvestigation.ts` (NDJSON parser in a hook — the proof-of-concept the page hook copy applied), `components/feed/InsightCard.tsx` (495 LOC, ~41 inline `style={{...}}` objects mixed with `className=` — the remaining concrete debt in the UI band). `lib/data-source/synthetic-data-source.ts` (516 LOC) is the new highest-LOC single file, but it's a data fixture + a small `callTool` dispatcher — wide *content*, narrow *interface*. That's a deep module, not a cognitive hotspot.
- **Unknown-unknowns.** `filterByStep` in `app/api/agent/route.ts:64-82` still reads `AgentEvent` shapes by tag and by a nested `agent` property — add a new event variant to `lib/mcp/events.ts` and the filter silently drops it from the demo replay. The 2026-06-16 sibling defense pattern (the `eval/` suite's goldens-empty pre-flight) is gone with the eval directory, so this is once again the only flagged unknown-unknown in the repo. Worth a typed-discriminator pass if a fourth `AgentEvent` variant ever lands.

The diagnostic frame is now smaller: the codebase isn't "complex," and the addresses that were complex have mostly been refactored or deleted. The lens names which symptom fires where, the rest of the audit walks each.

→ see `02-shallow-module-page-component.md` for the deep walk on the (now resolved) cognitive-load hotspot — kept as a worked example of how the shallow→deep refactor played out
→ see `03-insight-anomaly-silent-leak.md` for the change-amplification leak (now RESOLVED — kept as the worked example of the colocate-then-test fix)
→ see `04-synthesize-recovery-duplication.md` for the duplicated special case (now RESOLVED — kept as the worked example of "lift to the loop")
→ see `05-aptkit-primitive-adapter-boundary.md` for the new highest-leverage APOSD case study: the three small adapter classes in `lib/agents/aptkit-adapters.ts` that bridge AptKit's primitive interfaces to Blooming's domain

## deep-vs-shallow-modules

The depth axis still bites — and now teaches twice. The codebase has two textbook small-interface, fat-hidden-body case studies, at different scales: the `DataSource` seam at the protocol layer, and the AptKit primitive adapters at the library layer. The once-shallowest (`app/page.tsx`) has been pulled into the deep band by a three-hook extraction.

**Deep canon #1: the `DataSource` seam (`lib/data-source/`) — survived two adapter swaps.** `DataSource` is a 71-LOC interface (`lib/data-source/types.ts`) with two methods (`callTool`, `listTools`) and a small result envelope. Behind that surface today: **two** adapter implementations — `BloomreachDataSource` (214 LOC — cache + ~1 req/s spacing + retry-after grammar + OAuth tagging) and `SyntheticDataSource` (516 LOC — deterministic in-process Blooming-owned fake; the data fixture, the dispatch table, the `unwrap()`-shaped envelope; no subprocess, no network). The factory `makeDataSource(mode, sessionId)` (in `lib/data-source/index.ts`, 104 LOC) absorbs adapter selection, the OAuth-redirect-or-construct branch (Bloomreach), the schema-bootstrap branch difference (Bloomreach uses the live orchestrator; Synthetic returns a constant `syntheticWorkspaceSchema`), and the dispose semantics (both currently no-op; the factory shape kept the contract open).

**The seam IS the lesson, not the adapters behind it.** Phase 2 originally landed Olist (`OlistDataSource`, subprocess spawn + stdio MCP client) behind this interface; PR #8 removed Olist; PR `c75ec3e` added Synthetic. *The caller surface — what route handlers and agent classes consume — never changed across three adapter swaps.* That's the property of a real deep module: the interface holds, the implementations rotate. **Depth ratio: 2 methods + 1 factory function on top, ~830 LOC of adapter mechanics below.**

**Deepest single class: `BloomreachDataSource` (214 LOC, 2 methods).** Same depth ratio as the old `McpClient` (the class moved + renamed in PR A of Phase 2; the internals didn't change). Cache lookup, spacing gate, live transport call, retry with parsed `Retry-After`, error tagging, write-on-success only — all behind one `callTool`.

**Deep canon #2: the AptKit primitive adapter boundary (`lib/agents/aptkit-adapters.ts`, 206 LOC).** The arrival of `@aptkit/core@0.3.0` brought three primitive interfaces (`ModelProvider`, `ToolRegistry`, `CapabilityTraceSink`) and Blooming owns three small adapter classes that implement them (`AnthropicModelProviderAdapter` 45 LOC, `BloomingToolRegistryAdapter` 22 LOC, `BloomingTraceSinkAdapter` 43 LOC). Each adapter hides one specific translation: Anthropic SDK shape, `DataSource` envelope, NDJSON hook firing + `start↔end` pairing. The four production agent classes (`monitoring.ts` 116 LOC, `diagnostic.ts` 49 LOC, `recommendation.ts` 40 LOC, `query.ts` 34 LOC) all shrank to instantiate-three-adapters-and-forward shape — the loop body that used to live in each (or in the shared `runAgentLoop`) moved into `@aptkit/core` entirely. **This is the highest-leverage new APOSD case study in the codebase.** Same lesson as deep canon #1 (small interface, fat hidden body), applied at the library boundary instead of the protocol boundary. The two together teach the principle scaling across altitudes — see `05-aptkit-primitive-adapter-boundary.md` for the deep walk.

**`runAgentLoop` — split into legacy + library.** The 270-LOC shared loop now lives at `lib/agents/base-legacy.ts:86`, used by the four `*-legacy.ts` agent classes (retained as a regression seam; not on the production route paths). Active `lib/agents/base.ts` is a 14-LOC types module (`AGENT_MODEL`, `McpCaller`). Production agent classes (`monitoring.ts`, `diagnostic.ts`, `recommendation.ts`, `query.ts`) delegate the entire loop to AptKit, accessed via the three adapter classes above. The deep-module property carried forward: callers still see one method (`scan` / `investigate` / `propose` / `answer`); the loop mechanics are still hidden — just hidden one layer further away (across a library boundary instead of in the same module).

**Shallowest, now resolved: `app/page.tsx` (461 LOC, was 817).** The three-hook extraction landed: `useBriefingStream`, `useDemoCapture`, `useReconnectPolicy`. The page is no longer the shallowest module — it's now a layout-and-composition component with three depth hooks behind it. **`components/feed/InsightCard.tsx` (495 LOC, ~41 inline `style={{...}}` objects mixed with the occasional `className`) is the new shallowest live offender** — not because it spans many concerns, but because its rendering surface is wide.

**Honorable mentions:** `coverageFor` + `coverageReport` in `lib/agents/categories.ts` (pure schema gate, fat body); `SyntheticDataSource`'s `callTool` dispatch table (516 LOC of fixture + dispatch behind a single 2-method interface — wide content, narrow interface, textbook depth).

→ see `01-mcp-client-deep-module.md` for the historic deep walk on `McpClient` / `BloomreachDataSource`; updated to note the seam survived TWO adapter swaps (Olist added, Olist removed, Synthetic added)
→ see `05-aptkit-primitive-adapter-boundary.md` for the deep walk on the AptKit primitive adapter boundary — the second instance of the same pattern at a different scale
→ see `02-shallow-module-page-component.md` for the RESOLVED shallow-module verdict, kept as a worked example of the refactor

## information-hiding-and-leakage

Strong hides, the rack got wider with the AptKit adapter boundary, both 2026-06-02 leaks still closed.

**Strong hides (praise):**
- `lib/data-source/bloomreach-data-source.ts:57-74` — the `parseRetryAfterMs` helper owns the Bloomreach rate-limit error grammar (moved with the class in PR A; the regex didn't change). Two prose formats observed ("Retry after ~N second", "rate limit reached (1 per N second)"), one file. The grep test still passes — search the repo for `/retry-after/` and only this file matches.
- **`makeDataSource(mode, sessionId)` in `lib/data-source/index.ts:67-100`.** The factory hides three orthogonal facts from route handlers: which adapter to construct (Bloomreach vs Synthetic), the OAuth-redirect-or-construct branch (`{ ok: false, authUrl }` propagates from `connectMcp` only when Bloomreach), and the schema-bootstrap branch (Bloomreach calls `bootstrapSchema` against the live orchestrator; Synthetic returns a constant). Route handlers reach for `dsResult.dataSource` and `dsResult.dispose()`; nothing in `/api/agent` or `/api/briefing` knows which adapter is on the wire. Survived two adapter rotations (Olist added then removed, Synthetic added) without the factory shape changing — that's the property a factory-as-hide is supposed to have.
- **NEW — the AptKit primitive adapter boundary in `lib/agents/aptkit-adapters.ts`.** Three small adapter classes (`AnthropicModelProviderAdapter` 45 LOC, `BloomingToolRegistryAdapter` 22 LOC, `BloomingTraceSinkAdapter` 43 LOC) hide three orthogonal facts from `@aptkit/core`: the Anthropic SDK exists, the `DataSource` envelope exists, the NDJSON hook callbacks exist. AptKit's library code reads three generic interfaces (`ModelProvider`, `ToolRegistry`, `CapabilityTraceSink`); it does not import the Anthropic SDK, does not know what a `DataSource` is, does not know NDJSON exists. **This is the new highest-leverage information-hiding case study in the codebase** — small adapter, large hidden surface, repeats the same lesson as `parseRetryAfterMs` at a different scale. See `05-aptkit-primitive-adapter-boundary.md` for the deep walk.
- `lib/agents/base-legacy.ts:86-228` — `runAgentLoop` still owns the Anthropic tool-use protocol AND the structured-output recovery in the legacy seam. The four `*-legacy.ts` agent classes never touch `ToolUseBlock`, never construct `tool_result` blocks, never write a recovery turn. The active path (production routes) hides those same facts behind AptKit, accessed through the adapter boundary above.
- `lib/mcp/auth.ts:33-143` — three OAuth storage backends selected internally on `NODE_ENV`. Unchanged since 2026-06-02; still a strong hide.

**RESOLVED — the Insight↔Anomaly field-list leak.** `insightToAnomaly` now lives colocated with `anomalyToInsight` in `lib/state/insights.ts:25-55`. Crucially, the fix wasn't to make the dropped fields copy — it was to *name the drop as intentional* in a load-bearing comment (`lib/state/insights.ts:47-52`: "Reverse mapper. Intentionally drops evidence/impact/history/category — the agent loop only needs metric/scope/change/severity to investigate; the rest is regenerated downstream."). The round-trip test in `test/state/insights.test.ts` asserts the contract. The leak retired; the kept-as-worked-example pattern file (`03-`) is marked RESOLVED.

**RESOLVED — the duplicated `synthesize()` recovery.** Both copies are gone from `lib/agents/diagnostic.ts` and `lib/agents/recommendation.ts`. The strategy lifted into `runAgentLoop` as `parseResult: (text) => T | null` + `recoveryPrompt: (toolCalls) => string` (see `lib/agents/base-legacy.ts:86-228` for the residual legacy implementation). Agents pass their parser + prompt builder; the loop owns when to run the recovery turn. ~90 LOC removed. Kept as the worked example in `04-`.

**New, smaller leak worth naming honestly:** the **session-state shape** is owned in two places. `lib/state/insights.ts:8-12` defines `SessionFeed` ({ insights, investigations, anomalies }) as the canonical type, and the `state` Map at L14 is the only writer. Both `/api/briefing` and `/api/agent` route handlers read this same map directly (not through a façade). It's a small leak — they only read; there's no "two writers drift" failure mode — and centralizing wouldn't pay for itself today. Named for completeness, not for action.

→ see `01-mcp-client-deep-module.md` for the historic strong-hide example (`parseRetryAfterMs`); the same lesson now applies to the DataSource factory and to the AptKit adapter boundary
→ see `05-aptkit-primitive-adapter-boundary.md` — the deep walk on the three Blooming-owned adapter classes that hide Blooming's domain from `@aptkit/core`
→ see `03-insight-anomaly-silent-leak.md` — RESOLVED; kept as the worked example of the colocate-then-test fix
→ see `04-synthesize-recovery-duplication.md` — RESOLVED; kept as the worked example of the lift-to-loop fix

## layers-and-abstractions

Two seams now, not one. The request flow reads:

```
UI → route → Blooming agent class → AptKit primitive adapters → @aptkit/core loop
                                                                       │
                                                                       ▼
                                                          DataSource seam → adapter
                                                                       │
                                                                       ▼
                                                  (Bloomreach MCP server | SyntheticDataSource)
```

Phase 2 inserted the `DataSource` seam between the agents and the protocol adapters. The 2026-06-19 refresh inserts a *second* seam between the Blooming agent classes and the agent-loop mechanics — the AptKit primitive adapter boundary in `lib/agents/aptkit-adapters.ts`. Each boundary still transforms — routes add NDJSON framing + factory bootstrap + dispose semantics; Blooming agent classes construct three adapters and forward; the adapter classes translate (Anthropic ↔ ModelProvider, DataSource ↔ ToolRegistry, hooks ↔ CapabilityTraceSink); `@aptkit/core` runs the loop; the DataSource adapter (`BloomreachDataSource` or `SyntheticDataSource`) handles the protocol.

**Both seams earn their place.** Trace one axis (knowledge ownership: who knows X?) and the answers flip exactly once at each seam. *AptKit adapter boundary*: above it, code knows about Anthropic SDK and `DataSource`; below it, AptKit knows only its three primitive interfaces. *DataSource seam*: above it, code knows there's an abstract `DataSource` to call; below it, each adapter is a complete owner of its protocol. Strip either seam out and the layer above either has to learn the layer below's specifics (the four agent classes would each import `@aptkit/core`-specific shapes directly; route handlers would import `BloomreachDataSource` or `SyntheticDataSource` directly). With the seams, neither knowledge crosses up.

**The literal pass-through:** `BloomreachDataSource.listTools` (one line: `return this.transport.listTools()`). No cache, no spacing, no retry — unchanged since 2026-06-02. Still earns its place for the same reason: tool-list reads happen once at startup, don't count against the rate limit, and failures are fatal anyway. A second small pass-through lives in `BloomingToolRegistryAdapter.callTool` (`lib/agents/aptkit-adapters.ts:89-96`) — it forwards to `dataSource.callTool` and drops the `fromCache` field. The drop is the work; the forwarding is the residue. Pass-through-shaped but information-narrowing.

**`lib/mcp/client.ts` as a 17-line shim — honest trade-off, unchanged.** The file is still `export { BloomreachDataSource as McpClient, McpToolError, ... } from '../data-source/bloomreach-data-source'`. It would have been cleaner to delete the file and rename 16 test imports. The judgment: 16 test renames cost more than 17 lines of shim. This is "don't break existing seams when the cost of doing so exceeds the cost of keeping them," applied at the cleanup level. Worth naming because reviewers will ask why both paths exist.

**The `*-legacy.ts` parallel agent classes.** `lib/agents/{monitoring,diagnostic,recommendation,query,intent,categories,base}-legacy.ts` retain the pre-AptKit Blooming-owned implementations. Production routes don't import them; tests in `test/agents/base.test.ts` still exercise `runAgentLoop` via the `-legacy` import. The legacy seam earns its place as long as the AptKit migration is still settling — when AptKit's primitives stabilize (probably one or two minor versions), the legacy files can land in a delete PR. Worth naming because the file count looks alarming until you see the legacy/active split.

**Soft pass-through-shaped finding (unchanged):** the four active agent classes (`monitoring.ts`, `diagnostic.ts`, `recommendation.ts`, `query.ts`) all have constructor-plus-one-method shape, and the body is "instantiate three adapters + AptKit agent + forward." Keep as classes; AptKit's adapter pattern reads idiomatically with classes; a function shape would lose the constructor-once benefit.

## pull-complexity-downward

Two big pull-downs since 2026-06-02. The DataSource seam was the first; the AptKit primitive adapter boundary is the second.

**The 2026-06-19 pull-down: the entire agent loop dropped one layer further.** Before AptKit, each Blooming agent class held the loop body (legacy `runAgentLoop` in `base-legacy.ts:86-228`); the four agent classes each composed a parser + prompt builder + tool subset on top. After AptKit, the loop body moved into `@aptkit/core` entirely; the four active agent classes just instantiate three adapters and one AptKit agent, then forward. **Code that was Blooming's responsibility is now AptKit's.** That's the deepest possible pull-down: the complexity didn't move to a helper in the same package — it moved into an external library. The adapter classes are the price paid; the four agent classes get to be 30–50 LOC instantiate-and-forward shims.

**The earlier pull-down (still in force): the DataSource seam.** Routes used to construct `McpClient` themselves and run their own `connectMcp` ceremony; now they call `makeDataSource(mode, sessionId)` and read `{ ok, dataSource, bootstrap, dispose }`. **Caller code stayed the same size; the seam absorbed everything that would have grown.**

**The four other live findings:**

1. `BloomreachDataSource`'s constructor still defaults every knob (`minIntervalMs?: 200`, `maxRetries?: 3`, `retryDelayMs?: 10_000`, `retryCeilingMs?: 20_000`). Production overrides once at construction in `lib/mcp/connect.ts` (`minIntervalMs: 1100`). Per-call code never touches retry strategy. Unchanged.

2. `runAgentLoop`'s `maxTurns` and `maxToolCalls` (legacy seam) ARE pushed up to the four `*-legacy.ts` agent classes — correctly. The loop has no idea what role it's running. AptKit's active loops apply the same pattern (each agent class passes only what AptKit cannot default).

3. `cacheTtlMs` and `skipCache` on `BloomreachDataSource.callTool` are earned per-call knobs — `app/api/mcp/call/route.ts` (used by `/debug`) genuinely needs them.

4. **Resolved at the legacy seam, doesn't reappear at the AptKit seam: the `synthesisInstruction` boilerplate.** The pre-Phase-3 finding ("the shared 'you have NO more tool calls' prefix + closer is inline-duplicated across four agents") landed as `buildSynthesisInstruction(middle: string)` in `lib/agents/base-legacy.ts:230`. The four legacy agents now call it instead of constructing the wrapper inline. At the active path, prompt construction is `@aptkit/core`'s job — Blooming's agent classes don't construct synthesis prompts at all anymore. The finding closed itself once by the lift and a second time by the AptKit migration.

## errors-and-special-cases

Still the strongest design facet in the codebase. Three intentional error boundaries (the eval pre-flight finding from 2026-06-16 retired with PR #8's removal of the `eval/` directory):

- **`BloomreachDataSource`** masks rate-limit errors via parsed retry-after — silent retry, caller sees no exception, same return shape as first-try success. Transforms transport failures into `McpToolError(toolName, detail)`. Unchanged from 2026-06-02.
- **`@aptkit/core` agent loops** (active path) catch each tool call and feed failures back as `is_error: true` tool_result. One bad tool doesn't kill the run; the model can react. The "no parseable JSON" recovery — the historic `synthesize()` duplication target — lives in AptKit's loops on the active path and in `lib/agents/base-legacy.ts:213-217` on the legacy seam (the parameter shape from the 2026-06-15 lift carried into AptKit unchanged). The case is defined out of the agent layer at both paths.
- **Agent classes** mask parse/validate failures via `toBloomingAnomaly` / `toBloomingDiagnosis` / `toBloomingRecommendation` helper functions in `lib/agents/{monitoring,diagnostic,recommendation}.ts`. Route caller never writes a try/catch around the agent class.

Other layers read error-free. NDJSON consumers swallow malformed lines silently (correct for streamed NDJSON across HTTP).

**RESOLVED:** the `synthesize()` duplication. Both methods deleted; the recovery lives in `runAgentLoop` (now `base-legacy.ts`) and in the AptKit primitive `ModelProvider.complete` contract. See `04-synthesize-recovery-duplication.md` (kept as worked example).

→ see `04-synthesize-recovery-duplication.md` — RESOLVED, kept as the canonical "define it out" example
→ the 2026-06-16 sibling case study (the `eval/` goldens-empty pre-flight) RETIRED — directory removed in PR #8

## readability (names · comments · consistency · obviousness)

Strong overall. Comments stay strong; one consistency drift remains.

**Names (strong, 2 nits unchanged).** Most names are precise: `anomaly`, `diagnosis`, `schemaCapabilities`, `parseRetryAfterMs`, `forceFinal`, `synthesisInstruction`, `McpToolError`, `DataSource`, `makeDataSource`, `AnthropicModelProviderAdapter`, `BloomingToolRegistryAdapter`, `BloomingTraceSinkAdapter`. Two outliers still live, both in `lib/insights/derive.ts`: `r` (`const r = e?.result as ...` at L14, should be `result`) and `cp` (`const cp = findCurrentPrior(...)` at L29, should be `period`). Easy renames.

**Comments (strongest facet, stable).** The 6-line comment above `minIntervalMs: 1100` in `lib/mcp/connect.ts` is still the canonical example. Every file in `lib/data-source/` opens with a load-bearing header comment that names the seam's purpose, the lifecycle, and (for `bloomreach-data-source.ts`) the history of the rename. `lib/data-source/index.ts:1-24` calls out that the `'live-sql'` Olist branch was removed — that's a load-bearing comment because the absence of a removed branch is not visible in code and the next contributor would otherwise wonder if it was an oversight. `lib/state/insights.ts:47-52`'s "Intentionally drops evidence/impact/history/category" comment remains the canonical "comments carry intent TypeScript can't enforce" example.

**Consistency (one drift, still live).** Styling in `components/feed/InsightCard.tsx` (495 LOC, ~41 inline `style={{...}}` objects mixed with occasional `className=`). No stated rule for which to use where. Small fix: pull repeated style objects into named `CSSProperties` constants per component. The pattern already exists in `components/investigation/EvidencePanel.tsx`.

**Obviousness (strong, one deliberate surprise).** `useInvestigation` (`lib/hooks/useInvestigation.ts`) intentionally does NOT clean up its fetch on effect unmount. The comment documents why (React StrictMode mount-clean-remount aborted the stream and emptied the logs; the started-guard prevents double-fetch). `useBriefingStream` (the hook from Phase 1 page decomposition) copied the same discipline. Surprise justified, comment carries the WHY in both places.

**One new obviousness wart: the `*-legacy.ts` file naming convention.** `lib/agents/` now contains seven `*-legacy.ts` files alongside their active counterparts. A reader skimming the directory could reasonably wonder "which one runs?" The answer is "the non-legacy file in the active route paths; the legacy seam stays alive as a regression-test attachment point." A README inside `lib/agents/` would carry that intent better than the file naming alone. Worth naming, not load-bearing.

## red-flags-audit

The 12 AOSD red flags rescored against the 2026-06-19 codebase. Three of the top four 2026-06-02 fires remain RESOLVED. The 2026-06-16 `synthesisInstruction` medium fire dropped to LOW (the lift landed in `base-legacy.ts`).

```
RESOLVED since 2026-06-02
  RES  shallow module                was CRITICAL  app/page.tsx 817→461 LOC + 3 hooks
  RES  information leakage           was HIGH      insightToAnomaly colocated + comment
  RES  special-case sprawl           was HIGH      synthesize() → loop's parseResult/recoveryPrompt
  RES  partial pull-down            was MEDIUM    buildSynthesisInstruction(middle) in base-legacy.ts:230

FIRES (ranked, live)
  #1  convention drift              MEDIUM    inline-CSS vs Tailwind in InsightCard
  #2  pass-through method           LOW       BloomreachDataSource.listTools + BloomingToolRegistryAdapter.callTool (both earned)
  #3  vague names                   LOW       `r`, `cp` in lib/insights/derive.ts:14, :29
  #4  legacy shim                   LOW       lib/mcp/client.ts (17-line shim — earned, see layers)
  #5  parallel legacy files         LOW       7 *-legacy.ts files in lib/agents/ (active = retire on AptKit stable)

DOESN'T FIRE (praise, expanded)
  - classitis              4 active agent classes shrunk to instantiate-and-forward shims;
                            3 AptKit adapter classes earn their keep (one per primitive)
  - try/catch sprawl       errors masked at 3 intentional boundaries (DataSource, AptKit loop, agent classes)
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
→ see `05-aptkit-primitive-adapter-boundary.md` — new APOSD case study (the AptKit primitive adapter boundary)

---

## Top 3 ranked findings — 2026-06-02 set ALL RESOLVED

The original three fixes have landed:

1. **RESOLVED — page.tsx three-hook extraction.** Page 817→462 LOC; `useBriefingStream` (313 LOC), `useDemoCapture` (146 LOC), `useReconnectPolicy` (123 LOC) extracted into `lib/hooks/`. Worked example kept in `02-`. The actual LOC came in larger than predicted (page didn't shrink to ~120) because the layout JSX is itself non-trivial — directionally right, calibration off; lesson worth keeping.

2. **RESOLVED — `insightToAnomaly` colocated.** Now lives at `lib/state/insights.ts:53-55` next to its inverse. The fix wasn't to copy the dropped fields — it was to *make the drop intentional* via a load-bearing comment + round-trip test in `test/state/insights.test.ts`. The wire-format-rewrite "deeper fix" deliberately not done; the cheap fix retired the leak.

3. **RESOLVED — `synthesize()` lifted to `runAgentLoop`.** `parseResult` and `recoveryPrompt` options added to the loop (`lib/agents/base.ts:65-66`); the recovery turn lives at `lib/agents/base.ts:213-217`. Both agent-level `synthesize()` methods gone; ~90 LOC removed as estimated.

## Top 3 ranked findings — current set (2026-06-19)

The remaining live debt is small; the top three are all LOW or MEDIUM. Listing in priority order:

1. **Clean up the `InsightCard` styling drift** — `components/feed/InsightCard.tsx` (495 LOC, ~41 inline `style={{...}}` objects). Pull repeated style objects into named `CSSProperties` constants per section; the pattern is already in `components/investigation/EvidencePanel.tsx`. Single-file fix.

2. **Decide the `*-legacy.ts` retirement timeline** — `lib/agents/` carries seven `-legacy.ts` files alongside their active AptKit-backed counterparts. The legacy seam earns its place while AptKit stabilizes, but the directory is noisier than it should be once `@aptkit/core` reaches `1.0`. Worth a one-line `lib/agents/README.md` naming the intent (and a date or version threshold for the delete PR).

3. **Rename `r` / `cp` in `lib/insights/derive.ts`** — trivial; `r` → `result` at `:14`, `cp` → `period` at `:29`. Mentioned for completeness; not load-bearing.

The audit has effectively converged. The 2026-06-16 refresh recorded two strong design moves (the DataSource seam plus the domain-tool MCP server). The 2026-06-19 refresh records one *deletion* (Olist + `eval/` directory, in PR #8) and one *strengthening* (the AptKit primitive adapter boundary now teaches the same APOSD lesson as the DataSource seam at a different scale). The codebase has fewer moving parts and more design discipline than it did three weeks ago.

---
