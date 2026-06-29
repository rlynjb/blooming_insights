# audit — AOSD lenses walked against the current repo

Pass 1 of the two-pass output. Eight `##` sections, one per lens from `study-software-design.md`. Each lens reports what this repo actually does, with `file:line` grounding. When a finding earns its own Pass 2 file, this audit cross-links rather than restating the deep walk.

---

## 1. complexity-in-this-codebase

The diagnostic overview. AOSD names three symptoms: change amplification (one decision forces edits in many files), cognitive load (the module nobody wants to touch), and unknown-unknowns (you can't tell what's safe to change without reading everything).

### Top 3 complexity hotspots

  **`lib/data-source/synthetic-data-source.ts` (516 LOC).** The single largest module in the repo. The complexity isn't accidental — it's a 30-tool dispatch `switch` covering Bloomreach's MCP surface for offline use. But every new tool the agents reach for becomes a new `case` here AND a new entry in `lib/agents/tool-schemas.ts`. Change amplification factor: ~2 files per added tool. Acceptable for a fixture; worth knowing when planning a new agent capability.

  **`lib/agents/*-legacy.ts` (~1000 LOC across 9 files).** The retired pre-AptKit agent stack. Imported only by two test files (`test/agents/synthesis-instruction.test.ts:12` and `test/agents/base.test.ts:4`) and by other `-legacy` files self-referentially — nothing in `app/` or `components/` touches them. This is cognitive load that pays zero rent. → red flag: dead-code parallel structure (see lens 8).

  **`app/api/agent/route.ts` (345 LOC) and `app/api/briefing/route.ts` (336 LOC).** The two streaming routes. Each does: validation → cache lookup → DataSource bootstrap → schema bootstrap → agent invocation → NDJSON streaming → phase timing → AbortSignal threading → DataSource disposal. The phase-timing + AbortSignal-threading parts are duplicated almost verbatim. Pulling them into a single helper (`runAgentRoute({ phases, bootstrap, body }))` would halve the surface; the duplication is real and named.

### What this repo handles well

The agents themselves are tiny (`MonitoringAgent` 116 LOC, `DiagnosticAgent` 49 LOC, `RecommendationAgent` 40 LOC, `QueryAgent` 34 LOC) because the bridge in `aptkit-adapters.ts` does the work. That's deliberate depth — see lens 2 and `03-aptkit-bridge-information-hiding.md`.

---

## 2. deep-vs-shallow-modules

Module depth = functionality ÷ interface size. Deep modules hide a lot behind a small surface; shallow modules expose almost as much as they hide. AOSD's word for shallow-everywhere is **classitis**.

### The deepest module — `DataSource` (`lib/data-source/types.ts:63-71`)

The port. **2 methods** (`callTool`, `listTools`), each with a 1-line option type. Behind that surface sits 700+ LOC of behavior across two adapters: OAuth dance, 60s response cache, ~1 req/s rate-limit spacing, rate-limit retry ladder honoring server-stated penalty windows, AbortSignal composition with per-call 30s ceiling, typed error envelopes (`BloomreachDataSource`); plus a 30-tool dispatch switch with realistic envelope shapes (`SyntheticDataSource`). The agent layer holds a `DataSource`; it never knows which one.

→ see `01-port-and-adapter-data-source.md` for the full walk.

### The next-deepest — `readNdjson` (`lib/streaming/ndjson.ts:17-64`)

48-LOC body, ~10-line public type, consumed by 4 streaming surfaces (`useBriefingStream`, `useInvestigation`, `useDemoCapture`, `StreamingResponse`). Each consumer passes one `onEvent` callback and a `cancelOn` predicate — the kernel hides the reader/decoder/buffer/parse/cancel dance.

→ see `02-streaming-ndjson-kernel.md` for the full walk.

### The shallowest module — `lib/mcp/client.ts` (19 LOC, all re-exports)

```ts
export {
  BloomreachDataSource as McpClient,
  McpToolError,
  type CallToolOptions,
  type ListToolsOptions,
  type CallToolResult,
} from '../data-source/bloomreach-data-source';
```

Zero behavior. A pure compatibility shim. **This is fine** — the file's comment explicitly names its job (let legacy `McpClient` imports compile while callers migrate). The shallow-module rule is a smell, not a rule against named shims with a defined sunset.

### The shallowest module that ISN'T fine — `lib/agents/base.ts` (14 LOC)

```ts
export const AGENT_MODEL = 'claude-sonnet-4-6';
export type McpCaller = Pick<DataSource, 'callTool'>;
```

Two declarations the AptKit adapters use. Borderline classitis — both could live inline in `aptkit-adapters.ts` where their only consumers are. Not load-bearing enough to be a finding; named for the inventory.

### The classitis case — the parallel `-legacy.ts` files

`lib/agents/base-legacy.ts` (270 LOC), `monitoring-legacy.ts` (138), `diagnostic-legacy.ts` (112), `recommendation-legacy.ts` (105), `query-legacy.ts` (53), plus `categories-legacy.ts`, `intent-legacy.ts`, `legacy-validate.ts`, `legacy-prompts/`. Together they re-implement everything the new files do. **Fix:** if the tests in `test/agents/base.test.ts` and `test/agents/synthesis-instruction.test.ts` still cover behaviour the AptKit-wrapped versions need, port them; otherwise delete the legacy files entirely. The parallel structure is the single largest cognitive load this repo carries.

---

## 3. information-hiding-and-leakage

A decision leaks when two modules know the same fact and have to change together. The good news: the major hides in this repo are clean. The bad news: a few small leaks are worth naming.

### The cleanest hide — the AptKit bridge

`lib/agents/aptkit-adapters.ts` (206 LOC) holds the three adapter classes (`AnthropicModelProviderAdapter`, `BloomingToolRegistryAdapter`, `BloomingTraceSinkAdapter`) that translate between Blooming's domain types and `@aptkit/core`'s provider-neutral types. Blooming code touches `Anthropic.Messages.MessageParam`; AptKit touches `ModelMessage`. They never meet outside this file. Swap `@aptkit/core@0.3.0` for a future version, only `aptkit-adapters.ts` changes.

→ see `03-aptkit-bridge-information-hiding.md` for the full walk.

### The cleanest correctness hide — session-keyed state

`lib/state/insights.ts` (101 LOC) hides the fact that a single warm Vercel instance serves many users. The outer `Map<sessionId, SessionFeed>` is module-private; callers pass `sessionId` and get back a per-session sub-feed. The `putInsights` function clears *this session's* sub-maps without touching another user's feed — a correctness hide.

→ see `05-session-keyed-state.md` for the full walk.

### Leak #1 — two regex variants in `useReconnectPolicy.ts:33-34`

```ts
const AUTH_ERROR_RE_AUTO   = /invalid_token|unauthor|forbidden|401|session expired|reconnect/i;
const AUTH_ERROR_RE_BUTTON = /unauthor|forbidden|401|session expired/i;
```

Two predicates over the same fact (is this an auth error?), with the button version missing `invalid_token` and `reconnect`. The file's comment explicitly flags this as a latent bug filed for later. **This is the textbook AOSD red flag of "same knowledge edited twice."** Two predicates means two places to update when the Bloomreach server changes its error wording. **Fix:** unify behind a single predicate, with an explicit allowlist for the button case (e.g. `isAuthErrorAuto(msg) && !msg.includes('invalid_token')` if the button variant genuinely needs to exclude that token-shaped error). Manual verification against the live alpha server is the gate the comment names.

### Leak #2 — tool-name lists in three places

`bootstrapTools`, `monitoringTools`, `diagnosticTools`, `recommendationTools`, `queryTools` live in `lib/mcp/tools.ts:6-59`. The synthetic dispatcher's `switch` in `lib/data-source/synthetic-data-source.ts:334-493` re-enumerates those same names. Adding a new tool means: update `tools.ts`, add a `case` in `synthetic-data-source.ts`, add a description in the `toolDescriptions` map at line 120. The leak is mild (tool lists rarely change), but it's three edits per addition. **Fix:** when this changes more often, generate the synthetic dispatch from a single declarative table.

### Leak #3 — the NDJSON event union in two places

`lib/mcp/events.ts:4-12` defines `AgentEvent` (the shared contract). `lib/hooks/useBriefingStream.ts:36-45` defines `BriefingEvent` as a superset adding `workspace`, `coverage_item`, `coverage`. The route handler at `app/api/briefing/route.ts:56-60` defines yet another `BriefingEvent` as `AgentEvent | { type: 'workspace'... }`. Three definitions of overlapping unions. **Fix:** lift `BriefingEvent` (or the `workspace`/`coverage*` variants) into `events.ts` so the producer and consumer reference one source of truth. Low-risk; one PR.

### Praise — the captured fetch wrapper

`lib/mcp/transport.ts:103-118` (`makeCapturingFetch`). The fact that the MCP SDK's surface error message hides the real server body is hidden behind a fetch-wrapper that stores the body for the `SdkTransport` to attach to thrown errors. Callers never know there's a body holder. That's the right hide.

---

## 4. layers-and-abstractions

Pass-through methods (a method that just forwards to another) and pass-through variables (a parameter the caller threads through purely so the bottom of the stack can read it) signal layers that don't earn their place.

### The legitimate forward — `lib/mcp/client.ts`

The 19-line compatibility shim re-exports from `lib/data-source/bloomreach-data-source.ts`. This is a deliberate name-pass-through, not a layer-pass-through, and its sunset is named in the file comment.

### The legitimate forward — `bootstrap` in the DataSource factory

`lib/data-source/index.ts:67-100` returns `bootstrap: (signal?) => bootstrapSchema(bloomreachDs, { signal })` for live-bloomreach and `bootstrap: async () => syntheticWorkspaceSchema` for synthetic. Each branch adapts a real, different operation to the same call signature — that's not pass-through, that's the polymorphism the factory exists for.

### The honest pass-through chain — `signal`

The `AbortSignal` threading is *necessary* pass-through (the bottom of the stack genuinely needs it), but worth naming so a future reader sees the chain:

```
  route.signal → bootstrap(signal) → bootstrapSchema(_, {signal})
                                  → callOrThrow(_, _, _, {signal})
                                  → dataSource.callTool(_, _, {signal})
                                  → transport.callTool(_, _, {signal})
                                  → composeSignals(signal, timeout)
                                  → SDK client.callTool({signal})
```

Six hops. Every hop adds a `signal?` to a function signature and forwards it. That's the cost of cancellation that actually works — when AOSD says "pass-through is a smell," it means the parameter is read by *nothing in between*. Every layer here is the right place for `signal` to exist; the cost is just the verbose signatures. The current design is correct.

### The questionable pass-through — `sessionId` through agent constructors

`MonitoringAgent`, `DiagnosticAgent`, `RecommendationAgent`, and `QueryAgent` each accept `sessionId?: string` as a constructor argument they use only to forward to `AnthropicModelProviderAdapter` for log tagging. That's a true pass-through — none of the agent classes themselves read `sessionId`. **Fix when the agent classes refactor:** factor the adapter triplet construction into a helper (`buildAptKitDeps(anthropic, dataSource, schema, allTools, sid, agentName)`) that returns `{ model, tools, trace }`, so each agent class drops the `sessionId` parameter from its body.

---

## 5. pull-complexity-downward

The right place for a knob is inside the module that has enough information to make it itself. AOSD: avoidable config exposed to callers is the red flag.

### Top pull — the streaming kernel `readNdjson`

`lib/streaming/ndjson.ts:17-64`. Pulled the buffer/decoder/split/parse/cancel loop down. Four callers (`useBriefingStream`, `useInvestigation`, `useDemoCapture`, `StreamingResponse`) each pass one `onEvent` callback. The kernel decides: when to flush the trailing buffer, when to swallow malformed JSON, how to cancel between reads. Callers don't see any of it. **This is the cleanest pulled-complexity-down move in the repo.**

→ see `02-streaming-ndjson-kernel.md`.

### Pull — `composeSignals` in `lib/mcp/transport.ts:173-189`

The transport composes the route-level cancel signal with its own 30s ceiling using `AbortSignal.any` (with a manual `AbortController` fallback for older runtimes). Callers pass *one* signal; the transport composes. The OR is hidden.

### Pull — rate-limit retry ladder in `BloomreachDataSource.callTool`

`lib/data-source/bloomreach-data-source.ts:139-188`. The 60s response cache, the ~1 req/s spacing, the rate-limit-retry honoring the server's stated penalty window — all inside the adapter, none of it leaks to agents. The agent loop calls `dataSource.callTool(name, args, {signal})` and is done. Compare to a world where the agent had to check `isRateLimited()` itself.

### Anti-pull — the `whyItMatters` regex chain in `InsightCard.tsx:41-71`

```tsx
function whyItMatters(insight: Insight): string {
  const m = insight.metric.toLowerCase();
  let role: string;
  if (/revenue|purchase|sales|order|spend|aov|ltv|gmv/.test(m))
    role = 'a top-line revenue metric — a move here flows straight to income';
  else if (/conversion|checkout|cart|funnel|abandon/.test(m))
    role = 'a funnel metric — it tracks how efficiently visits turn into orders';
  // ... 6 more arms
}
```

This is a **fallback for when the monitoring agent's `insight.impact` field is missing**. It belongs next to `deriveInsightFields` in `lib/insights/derive.ts`, where the rest of the evidence-derivation lives. The UI shouldn't carry agent fallback logic. The pull is downward, not upward — out of the React component into the pure-logic module that already exists for exactly this. **Fix:** move the function, re-export, call it from the component.

### Anti-pull — `forcedDemo` flag in `app/page.tsx:61`

`const forcedDemo = process.env.NEXT_PUBLIC_DEMO_ONLY === '1';` is read in the component body, used to decide whether to render the demo/live toggle. The flag itself is fine (it's an explicit deployment switch). But the component also reads `process.env.NODE_ENV !== 'production'` at line 360 to gate the capture button. Two env reads in one component, both gating UI affordances. **Fix:** when this grows a third, lift into a `useFeatureFlags()` hook that returns `{ forcedDemo, showCaptureButton }`.

---

## 6. errors-and-special-cases

AOSD's strongest advice on errors: define them out of existence where you can; aggregate at the right layer otherwise. Avoid scattering `try/catch` at every call site.

### The right aggregation — `BloomreachDataSource.callTool`

Tool errors are aggregated into a single typed `McpToolError` (`lib/data-source/bloomreach-data-source.ts:101-110`) that carries the tool name + a redacted server detail. Every layer above the adapter catches one error type; the underlying SDK throw with its `cause` chain is hidden. Compare to a world where every route handler checked `err.code === 'rate_limited'` itself.

### The right transport-level aggregation — `composeSignals` and `formatError`

`composeSignals` (`lib/mcp/transport.ts:173-189`) and `formatError` (`lib/mcp/transport.ts:82-97`) define the "cancel OR timeout" decision and the "walk-the-cause-chain-into-a-redacted-string" decision out of every caller. The route handlers each just write `console.error('[briefing] error:', redactSecrets(formatError(e)))` — one line.

### The right defined-out — empty `evidence` array in `insightToAnomaly`

`lib/state/insights.ts:53-55`. The reverse mapper intentionally drops `evidence/impact/history/category` — *the agent loop only needs `metric/scope/change/severity` to investigate; the rest is regenerated downstream.* This is "define the special case out of existence" — instead of conditionally handling "what if evidence is stale," the function guarantees an empty array, and the diagnostic agent regenerates real evidence in its own pass.

### Try/catch sprawl in the streaming routes

`app/api/briefing/route.ts` and `app/api/agent/route.ts` each carry 2-3 `try { } catch (e) { ... }` blocks: one outer for setup errors, one inner for the stream body, one inside `finally` for dispose. This is the right number — each catch handles a different layer's failure with a different recovery — but the pattern is duplicated between the two routes. **Fix (cross-references lens 1):** the duplication itself is the smell, not the try/catch count.

### `localStorage` / `sessionStorage` try/catch sprawl

Six `try { ... } catch { /* ignore */ }` blocks across `app/page.tsx`, `useInvestigation.ts`, `useBriefingStream.ts`, `useReconnectPolicy.ts`. Each guards a Storage API call that throws when blocked (private browsing, quota-full, no Storage in SSR). The repeat is honest but pulled-down would help: a `safeStorage.get(key)` / `.set(key, value)` helper that swallows the throw at one site. **Fix:** add `lib/storage/safe.ts` next time a fourth consumer appears.

---

## 7. readability (names · comments · consistency · obviousness)

Four facets in one lens.

### Names — strong

The names in this repo carry weight: `DataSource`, `BloomreachDataSource`, `SyntheticDataSource`, `readNdjson`, `runAgentLoop`, `composeSignals`, `formatError`, `redactSecrets`, `makeCapturingFetch`, `McpToolError`, `parseLiveMode`, `makeDataSource`. Each one names a real concept. **No `data`, `obj`, `tmp`, or `manager` to flag.**

The one borderline name: `McpCaller` in `lib/agents/base.ts:14` is defined as `Pick<DataSource, 'callTool'>`. The name reads as "thing that calls MCP" but the type means "thing that *exposes* a callTool method." `DataSourceCallSurface` or `CallableDataSource` would read more accurately. Minor.

### Comments — strong, especially the longer files

Where this repo shines. Three exemplary blocks:

  → `lib/data-source/bloomreach-data-source.ts:1-14` — the file-level comment names what `BloomreachDataSource` carries (OAuth, 60s cache, rate-limit ladder, AbortSignal composition, retry ceiling logic) and the history (was `McpClient` in `lib/mcp/client.ts` before PR A). A reader gets oriented in 14 lines.
  → `lib/hooks/useReconnectPolicy.ts:1-31` — the file-level comment names the two regex variants are NOT unified (and why), cross-links the refactor spec where the unification work is filed, and explicitly calls out the latent bug. This is the right way to comment a knowingly-imperfect module.
  → `lib/state/insights.ts:1-12` — the type and module comment explain *why* the outer Map is never cleared (concurrent users on a warm Vercel instance) and what the failure mode would be if it were. A reader who has never seen the file knows the load-bearing invariant in 12 lines.

### Comments — the borderline cases

Inline comments inside `useBriefingStream.ts` are occasionally narrative ("revoked-token reconnect policy (state + one-shot guard + reset+reload)" at line 51 of `app/page.tsx`). They're not wrong, but they restate what the next few lines already say. Acceptable for a complex page module; would be noise in a 30-line helper.

### Consistency — one significant inconsistency

The `-legacy` suffix vs the lack of one. Some legacy files use the suffix (`base-legacy.ts`); the `legacy-prompts/` folder uses a `legacy-` prefix instead. The new code never carries a marker (`base.ts`). Inconsistent enough that a reader has to learn both. **Fix:** when the legacy code is deleted (lens 2), the inconsistency disappears.

### Obviousness — the surprise spots

Two spots a reader might trip on:

  → **`useInvestigation.ts:36-37`** — the comment block explains *why* the hook deliberately does NOT cancel its fetch on cleanup (React StrictMode mount → cleanup → re-mount would abort the stream). Without that comment a reader would "fix" the missing cleanup and break the dev experience. The comment is the saving grace; the surprise is real.
  → **`app/page.tsx:77`** — `else if (saved === 'live-sql' || saved === 'live') setMode('live-bloomreach'); // legacy`. The two legacy `localStorage` values are migrated to the current value silently. A reader scanning the mode switch sees three modes; the migration arm is the surprise. The `// legacy` comment is correct; consider naming `LEGACY_MODE_VALUES = ['live-sql', 'live']` for the inventory.

---

## 8. red-flags-audit

The capstone lens. AOSD's red flags as a review checklist, marked against this repo.

```
  flag                          status            location / fix
  ───────────────────────────── ───────────────── ─────────────────────────────
  shallow module                doesn't fire      base.ts is borderline; everything
                                                  else is named/sized appropriately
  classitis                     FIRES             lib/agents/*-legacy.ts (9 files,
                                                  ~1000 LOC) — delete or migrate
                                                  the 2 tests still importing them
  information leakage           FIRES             (a) two regex variants in
                                                  useReconnectPolicy.ts:33-34
                                                  (b) BriefingEvent defined 3 times
                                                  (events.ts, useBriefingStream.ts,
                                                  briefing/route.ts)
  temporal decomposition        doesn't fire      modules are decomposed by concept
                                                  (data-source, agents, state,
                                                  streaming, hooks), not by phase
  same knowledge edited twice   FIRES             tool-name lists in tools.ts and
                                                  synthetic-data-source.ts switch;
                                                  two regex variants above
  pass-through method           doesn't fire      see lens 4 — every layer earns
                                                  its place; sessionId pass-through
                                                  is the one minor case
  pass-through variable         doesn't fire (1)  signal pass-through is necessary;
                                                  sessionId in agent constructors
                                                  is the borderline minor case
  vague names                   doesn't fire      see lens 7 — names carry weight
  comments restate code         rare / minor      occasional in app/page.tsx,
                                                  acceptable for a complex page
  missing interface comment     doesn't fire      every public module has a
                                                  file-level comment
  try/catch everywhere          doesn't fire      see lens 6 — aggregation is right
  special-case sprawl           doesn't fire      see lens 6 — `evidence: []` is
                                                  the cleanest defined-out
  avoidable config exposed      FIRES (mild)      whyItMatters() in InsightCard
                                                  belongs in lib/insights/derive.ts
  generic decoration            doesn't fire      no generic wrappers without depth
  layer not earning its place   doesn't fire      see lens 4 — the factory and the
                                                  client.ts shim are intentional
  hidden control flow           doesn't fire      every async/cancellation path
                                                  is named in the comments
```

### Ranked by severity for this repo

  1. **classitis — the parallel `-legacy.ts` files.** Largest LOC, zero production callers, two stranded tests. The single biggest readability cost.
  2. **same knowledge edited twice — the two regex variants in `useReconnectPolicy.ts`.** A named latent bug. Highest fix-value per LOC.
  3. **information leakage — `BriefingEvent` defined three times.** Low-risk one-PR fix; lifts the contract into the existing `events.ts` source of truth.
  4. **avoidable config exposed — `whyItMatters` in `InsightCard.tsx`.** Cross-cutting fix: move to `lib/insights/derive.ts`. Tightens the lens-5 anti-pull and the lens-3 leak in one move.
  5. **same knowledge edited twice — tool-name lists.** Lowest urgency (tool lists rarely change); worth a declarative table when the next agent capability ships.

The Pass 2 files take the deep walks on the design moves these red flags either preserve (the legitimate hides) or violate (the leaks). Read in the order the README names — overview, then audit, then the design move whose primitive matters most to you today.
