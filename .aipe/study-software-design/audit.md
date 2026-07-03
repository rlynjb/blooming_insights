# Audit — 8 lenses across blooming insights

The 8 AOSD lenses walked against the current repo. Each lens names the AOSD red flag(s) that fire it, cites real paths + line ranges, ranks the findings, and (when the finding earned a Pass 2 file) cross-links to the deep walk.

Order matters: complexity first (the diagnostic overview), then the primitives (deep-vs-shallow → info hiding → layers → pull-down → errors → readability), then the red-flag capstone as the actionable index.

## Verdict up front

The two rank-ordered findings for the whole audit:

1. **Deep-module wins outnumber leaks 3-to-1** — the port + adapter + decorator + preset + factory in `lib/data-source/` (5 files, ~1100 LOC total), the strategy-pattern auth providers in `lib/mcp/auth-providers/` (3 flows behind one 10-method interface), and the NDJSON kernel in `lib/streaming/ndjson.ts` (64 LOC that replaces 4 hand-rolled parse loops) are all textbook AOSD moves. The seam has shipped **5 uses without a caller-surface change** — the tier-2 receipt.

2. **The #1 fix is not a bug** — it's the 9 files (~1000 LOC) in `lib/agents/*-legacy.ts`. Preserved as a migration rollback receipt; imported now by only 2 test files. Time to remove; the AptKit-backed replacements are load-bearing and the tests can port to them.

---

## 1. complexity-in-this-codebase

The diagnostic overview. Three symptoms to locate: change amplification (one edit touches many files), cognitive load spikes (the module nobody wants to touch), and unknown unknowns (surprising behavior hiding behind a normal-looking name).

**Change amplification — where a single edit ripples:**

- `lib/mcp/types.ts` (141 LOC) — the shared data-model file. Adding a field to `Insight`, `Anomaly`, `Diagnosis`, or `Recommendation` cascades into the UI (`components/feed/*`, `components/investigation/*`), the demo snapshots (`lib/state/demo-*.json`), the validators (`lib/mcp/validate.ts`), the NDJSON contract (`lib/mcp/events.ts`), and the agents. This is a *centralized* shared vocabulary — the cost is real but the alternative (each layer defining its own shape) is worse. Optional-field discipline (`context.md`: "new fields stay optional so older snapshots still validate") is the mitigation.

- `app/api/briefing/route.ts` (341 LOC) — the route that runs monitoring and emits the NDJSON. Every new event type, every new dispatch case, every schema addition passes through here. Reasonable given the streaming discipline, but the length is the largest procedural file after the legacy agent loop.

**Cognitive-load hotspot — the module you'd hesitate to touch:**

- `lib/agents/aptkit-adapters.ts` (260 LOC) — three classes in one file (`AnthropicModelProviderAdapter`, `BloomingToolRegistryAdapter`, `BloomingTraceSinkAdapter`). Two-directional shape mapping (Anthropic ↔ AptKit ↔ Blooming) plus budget tracking, prompt caching, and trace-event fan-out. The right decision (single directory of "here be the adapter bridge"), but the load is real. → see `01-port-adapter-decorator-preset-factory.md` for why this is deep, not shallow.

**Unknown-unknown — surprising behavior behind a normal name:**

- `lib/mcp/auth.ts` (259 LOC) still exports `BloomreachAuthProvider`, but the honest new home is `lib/mcp/auth-providers/bloomreach.ts`, which just re-exports it. A newcomer opening `auth-providers/` sees three siblings (bloomreach, bearer, anonymous) and reasonably assumes the class lives in `bloomreach.ts` — it doesn't. Deliberate (the class was designed to live in `auth-providers/` from the start; the re-export is the plan's non-disruptive path) but worth naming.

**Ranked hotspots (highest complexity first):**

1. `lib/agents/aptkit-adapters.ts` — three-class bridge, two-way mapping, plus budget + caching
2. `app/api/briefing/route.ts` — the largest procedural route (341 LOC) and the NDJSON entry point
3. `lib/data-source/synthetic-data-source.ts` — 516 LOC of deterministic fake data; long, but the length is *data* not logic

---

## 2. deep-vs-shallow-modules

Depth = functionality ÷ interface size. Big body behind a small interface is deep (good); interface as wide as the body is shallow (classitis).

**Red flag: shallow module / classitis.**

**Deepest module in the repo (the win):**

`lib/data-source/types.ts` — the **port** (`DataSource` interface). 71 LOC of interface plus doc comments; 2 methods (`callTool`, `listTools`). Behind that surface: OAuth 2.1 + PKCE + DCR session persistence, ~1 req/s rate limiting, 60s response cache, rate-limit retry ladder with parsed penalty windows, AbortSignal composition, McpToolError tagging. All hidden. The agents hold a `DataSource`, never a concrete adapter. → see `01-port-adapter-decorator-preset-factory.md` for the full walk.

Runner-up: `lib/mcp/auth-providers/index.ts:56` — `makeAuthProvider({type, sessionId, redirectUri, bearerToken})`. 10 lines of switch statement pick one of three wildly different auth flows (OAuth PKCE DCR, static bearer, no-op) and return them typed as one interface. Consumer (`connectMcp` at `lib/mcp/connect.ts:82-140`) doesn't know which fired. → see `02-auth-strategy-injection.md`.

Runner-up 2: `lib/streaming/ndjson.ts:17-64` — `readNdjson(body, onEvent, opts)`. 4-argument signature; behind it the whole "fetch → reader → TextDecoder → split → parse → dispatch" loop, plus trailing-buffer flush, malformed-line skip, and mid-stream cancel poll. Four call sites (feed, capture, investigation hook, chat) share it. → see `01-port-adapter-decorator-preset-factory.md` (the pulled-down kernel).

**Shallowest module — the top offender:**

`lib/agents/*-legacy.ts` — 9 files, ~1000 LOC total, imported by only 2 test files (`test/agents/base.test.ts`, `test/agents/synthesis-instruction.test.ts`) plus each other. Each `*-legacy.ts` is a thin wrapper around `runAgentLoop` from `base-legacy.ts` — the AptKit migration replaced these with `lib/agents/monitoring.ts` (116 LOC), `diagnostic.ts` (67 LOC), `recommendation.ts` (47 LOC), `query.ts` (34 LOC). The parallel exists deliberately: it's the rollback receipt for the AptKit migration. But nothing in `app/` reaches for them anymore.

**Verdict:** the legacy files are neither shallow nor deep — they're **frozen**. They were once the deep modules; they've been superseded. The fix isn't refactoring; it's deletion. The 2 test files that still import them either port to the AptKit-backed classes or become archival evidence. **Do this next.**

**Second-tier shallow module:**

`lib/mcp/session.ts` (29 LOC) — a `sessionCookie()` helper. Small. Not classitis, just genuinely small — the shape is honest. Not a finding.

**Ranked:**

1. `lib/agents/*-legacy.ts` × 9 files (~1000 LOC) — frozen shallow parallel. **Remove.**
2. Nothing else fires the shallow-module red flag. The rest of the repo either uses depth well or is honestly small.

---

## 3. information-hiding-and-leakage

Look for decisions that leak — a fact known in two modules that forces them to change together; temporal decomposition; config that exposes internals.

**Red flag: information leakage; same knowledge edited twice.**

**Deliberate hiding wins (praise as finding):**

- `lib/mcp/config.ts` (146 LOC) — the client's localStorage is invisible to the server; the server's env is invisible to the client; only the base64-encoded header carries what's needed. The precedence chain (UI override → env → hardcoded default) is documented in `resolveConfig` and implemented in `mcpUrl()` at `lib/mcp/connect.ts:38-48`. Neither side of the boundary needs to know how the other picked its default. → see `04-client-server-contract-module.md`.

- `lib/data-source/mcp-data-source.ts` (27 LOC) — the class body is *not* in this file. It's a pure re-export from `bloomreach-data-source.ts`. The "how it's spelled today" (McpDataSource) is separated from "where the code lives" (the historical name). → see `03-rename-via-reexport.md`.

- `lib/mcp/auth-providers/bloomreach.ts` (16 LOC) — also a re-export. Same pattern.

**Actual leakage (small):**

- The Bloomreach 10-second penalty window appears in **two** places: `lib/data-source/bloomreach-data-source.ts:135` (`retryDelayMs: opts.retryDelayMs ?? 10_000`) and `lib/mcp/connect.ts:120-125` (the connect-time defaults override it back to 10_000). If Bloomreach changes its rate limit, both files need editing. Small, but a real seam.

- `AGENT_MODEL = 'claude-sonnet-4-6'` in **both** `lib/agents/base.ts:7` and `lib/agents/base-legacy.ts:10`. Same reason as (1) above — until the legacy files are removed, model-string edits happen twice.

**Ranked (worst first):**

1. Duplicated `AGENT_MODEL` and duplicated agent loop shape across the legacy tree (subsumed by the deletion fix in lens 2 — no separate action needed).
2. Bloomreach penalty window in two places. **Fix later:** one exported constant.
3. Everything else honors the hiding discipline. The client/server config split (`lib/mcp/config.ts`) is a textbook win.

---

## 4. layers-and-abstractions

Find pass-through methods, pass-through variables, and adjacent layers offering the same abstraction — a layer not earning its place.

**Red flag: pass-through method/variable.**

**Layers that earn their place:**

The layer chain for a live agent call is:

```
  agents        (MonitoringAgent, DiagnosticAgent, ...)
      │
      ▼
  AptKit adapters   (BloomingToolRegistryAdapter)
      │
      ▼
  DataSource port   (types.ts — 2 methods)
      │
      ▼
  DataSource adapter   (BloomreachDataSource — cache + rate-limit + retry)
      │
      ▼
  McpTransport         (SdkTransport)
      │
      ▼
  MCP SDK Client
```

Every layer adds something. `AptKit adapters` maps shapes (Anthropic ↔ AptKit ↔ Blooming trace events). The `DataSource` port narrows the surface. The adapter adds cache + rate-limit + retry + AbortSignal + typed errors. `SdkTransport` isolates the SDK's raw calls behind the `McpTransport` interface (which is what the `HttpErrorHolder` capturing-fetch attaches to). Nothing is straight forwarding.

**Small pass-through — the honest finding:**

`lib/agents/aptkit-adapters.ts:143-145` — `BloomingToolRegistryAdapter.callTool` calls `this.dataSource.callTool(name, args, options)` and returns `{result, durationMs}`. Almost a pass-through — it drops `fromCache` because AptKit's `ToolRegistry` interface doesn't carry it. The drop is deliberate (upstream trace hooks pick up `fromCache` from `BloomingTraceSinkAdapter`) but it's the closest thing to a pass-through in the repo. Not worth changing; the alternative (thread `fromCache` through AptKit's foreign interface) would violate its abstraction.

**Ranked:**

1. No pure pass-through layers fire the red flag in this repo.
2. The one near-miss (adapter-registry `callTool`) is honest.

---

## 5. pull-complexity-downward

Find knobs pushed up to callers that the module had enough information to decide itself.

**Red flag: avoidable config exposed to users.**

**Praise as finding — knobs pulled down correctly:**

- `readNdjson` in `lib/streaming/ndjson.ts` takes 3 arguments (`body`, `onEvent`, `opts` for cancel + malformed-line callback). It does *not* expose the buffer strategy, the chunk size, the decoder settings — the caller couldn't do anything useful with them anyway. 4 call sites, none forced to know the parse loop.

- `BloomreachDataSource` in `lib/data-source/bloomreach-data-source.ts` owns `minIntervalMs` (~1 req/s spacing), `retryDelayMs` (10s penalty window), `retryCeilingMs` (20s cap), `maxRetries` (3). The consumer sets them once at `connectMcp` (`lib/mcp/connect.ts:120-125`) with defaults that reflect Bloomreach's observed behavior; agents that only need `callTool` never see any of them.

**Knobs still up at the caller (real finding):**

- `CallToolOptions.skipCache` and `CallToolOptions.cacheTtlMs` in `lib/data-source/bloomreach-data-source.ts:22-26`. The 4 MCP routes (`/api/mcp/{call,tools,tools/check,capture}`) rely on `skipCache` to force fresh reads for the capture path. The knob is unavoidable — the module can't tell "the debug tool wants uncached" from "any other caller." Reasonable.

- The `sessionId` argument threaded through `makeDataSource` → `connectMcp` → `BloomreachAuthProvider`. It's request-scoped state; the module can't pull it down because there's no per-process session. Also unavoidable.

**Ranked:**

1. No red-flag knobs currently pushed up. The two remaining caller-visible knobs (`skipCache`, `sessionId`) are load-bearing.

---

## 6. errors-and-special-cases

Find exception handling scattered across call sites and special cases a different definition would erase.

**Red flag: try/except everywhere; special-case sprawl.**

**Errors defined out (praise):**

- `McpToolError` in `lib/data-source/bloomreach-data-source.ts:101-110` — one typed error carrying `toolName + detail`. Route handlers catch one class instead of parsing generic `Error.message`. The transport failure path (401 Unauthorized) and the `isError: true` tool result path both end up here.

- Rate-limit *retries* are not error-handling — they're normal control flow inside `BloomreachDataSource.callTool` at `lib/data-source/bloomreach-data-source.ts:163-174`. The consumer sees success or `McpToolError`; the retry loop is invisible. Textbook error-definition-eliminates-special-cases.

- `readNdjson` swallows malformed lines by default and surfaces them through the optional `onMalformed` callback (`lib/streaming/ndjson.ts:47`). The consumer chooses whether to care; the kernel doesn't grow a strict/lenient mode flag.

**Special-case sprawl (small):**

- Auth flow errors: `BloomreachAuthProvider` captures `lastAuthorizeUrl` and `connectMcp` at `lib/mcp/connect.ts:127-139` reaches back for it inside the catch. The `provider instanceof BloomreachAuthProvider` guard is the special case — bearer and anonymous providers throw if they end up in the OAuth flow (which is the correct behavior). Deliberate; the alternative is to lift `lastAuthorizeUrl` to the base interface, but only one provider has one, so that would be shallow-module bait.

- Fault-injection errors in `lib/data-source/fault-injecting.ts:118-146` — 4 fireX() private methods, one per fault kind. Could be a switch. As-is, each fault owns its shape (timeout error message, HTTP 429 with `.status`, HTTP 500, malformed-json ToolResult). The four are genuinely different; the sprawl is honest.

**Ranked:**

1. No scattered try/catch fires the red flag. The `McpToolError + retry ladder + malformed-line callback` design is a textbook error-definition win.

---

## 7. readability (names · comments · consistency · obviousness)

Four facets in one lens. Each red flag counted separately.

### Names

**Precision wins:** `readNdjson`, `BloomreachDataSource`, `McpConfigOverride`, `FaultInjectingDataSource`, `bootstrapSchema`, `McpToolError` — each name predicts its body. No `Manager`, `Helper`, `Utils`, or `Handler` classes.

**Legacy name still doing work:** `BloomreachDataSource` is now the *class name* but not the *layer name* — the interface is `DataSource`, the alias is `McpDataSource`, but the file that exports the concrete class is still `bloomreach-data-source.ts`. The class is generic (works against any MCP server); "Bloomreach" is the historical first user. Deliberate (the plan's non-disruptive naming path — see `mcp-data-source.ts` header comment) but a real reader trip-wire.

**Small vagueness:** `parseAgentJson` in `lib/agents/legacy-validate.ts` — "agent" is vague when 4 agents produce differently-shaped output. The paired `isAnomalyArray` / `isDiagnosis` / `isRecommendationArray` guards clarify it, but the parse function name doesn't stand alone. Subsumed by the legacy deletion.

**Verdict:** naming is above average. The one legacy naming friction (`BloomreachDataSource` class in `mcp-data-source.ts`-aliased directory) is explained in-file, so a reader who opens the code finds the explanation. Not a fix.

### Comments

**Comments that carry what code can't:** almost every file in `lib/data-source/`, `lib/mcp/`, and `lib/streaming/` opens with a header block that explains *why* the shape is what it is — trade-offs, history, budget implications. Example: `lib/data-source/bloomreach-data-source.ts:1-14` (header explaining the Bloomreach adapter's history and why it's identical to what it was pre-rename). Example: `lib/streaming/ndjson.ts:1-13` (why the trailing-buffer flush exists). Example: `lib/data-source/fault-injecting.ts:11-16` (**the 5-uses receipt** — the file that names the seam-uses count as the tier-2 story).

**Missing interface comment (one):** the exported `readNdjson` has a one-line JSDoc; adequate. `makeAuthProvider` at `lib/mcp/auth-providers/index.ts:56` has none — the switch is self-explanatory, but a one-line JSDoc summarizing "picks a provider by discriminant" would help.

**Comments that restate the code:** none found in the audit sample.

**Verdict:** the comment density is high on the load-bearing files (interfaces, kernels, decorators) and correctly low on the leaf data-shape files. The 5-uses receipt comment in `fault-injecting.ts:11-16` is the load-bearing example — it's the sentence a reader takes with them.

### Consistency

**Two-conventions-for-one-job (one, small):** the DataSource result envelope uses camelCase (`{result, durationMs, fromCache}`); the raw NDJSON events also use camelCase; the McpConfigOverride fields (`authType`, `bearerToken`) match. Consistent.

The one shape swing: `Insight | Anomaly | Diagnosis | Recommendation` all use camelCase field names, but `evidence[].tool` uses lowercase because it's the MCP tool name (external). That's not inconsistency; it's a real boundary.

**Verdict:** consistent. No red flag.

### Obviousness

**The "huh?" spots:**

- `lib/mcp/auth.ts` still exporting `BloomreachAuthProvider` while `lib/mcp/auth-providers/bloomreach.ts` re-exports it. If you open `auth-providers/` first, the file with the class body isn't in the folder. See lens 1's unknown-unknown finding.

- `lib/agents/base.ts` (14 LOC) is tiny; it defines only `AGENT_MODEL` and `McpCaller`. A newcomer expecting the agent loop here finds it in `base-legacy.ts`. Also subsumed by the legacy deletion.

**Verdict:** two "huh?" spots, both subsumed by the deletion of the legacy tree. Not new fixes.

### Ranked (per facet, worst first):

- Names: `BloomreachDataSource` class in `mcp-data-source.ts`-aliased directory. Explained in-file.
- Comments: missing one-line JSDoc on `makeAuthProvider`. Trivial.
- Consistency: no finding.
- Obviousness: `lib/agents/base.ts` (14 LOC) vs `base-legacy.ts` (270 LOC). Subsumed.

---

## 8. red-flags-audit

Ousterhout's red flags as a checklist. Each marked against this repo: **fires** / **doesn't** / **N/A**. Sorted by severity for THIS repo.

| # | red flag | verdict | evidence + one-line fix |
|---|----------|---------|-------------------------|
| 1 | **Shallow module (classitis)** | **fires** | `lib/agents/*-legacy.ts` × 9 files, imported by 2 test files. **Fix:** port the 2 tests to the AptKit-backed classes, then delete the legacy tree. |
| 2 | **Information leakage (repeated knowledge)** | **fires (small)** | Bloomreach 10s window in `bloomreach-data-source.ts:135` + `connect.ts:120`. **Fix:** one exported `BLOOMREACH_PENALTY_MS` constant. |
| 3 | **Temporal decomposition** | doesn't | No module structured "step 1 / step 2 / step 3." The agent loop is inside AptKit, not the repo's problem. |
| 4 | **Overexposure (avoidable knobs pushed up)** | doesn't | The exposed knobs (`skipCache`, `sessionId`) are load-bearing; the caller has information the module cannot infer. |
| 5 | **Pass-through method/variable** | doesn't | The one near-miss (`BloomingToolRegistryAdapter.callTool`) is deliberate (AptKit's `ToolRegistry` interface doesn't carry `fromCache`). |
| 6 | **Pass-through decoration** | doesn't | `FaultInjectingDataSource` adds real behavior (fault injection); it's a real decorator, not a wrapper for its own sake. |
| 7 | **Repeated code** | doesn't | The NDJSON parse loop that used to appear 4 times is now one kernel (`lib/streaming/ndjson.ts`). |
| 8 | **Special-case sprawl** | doesn't | `McpToolError` + the retry ladder + `readNdjson`'s malformed-callback erase what would otherwise be scattered try/catch. |
| 9 | **Conjoined methods (must be called in sequence)** | doesn't | `makeDataSource → bootstrap → callTool` is a sequence, but each stage returns a self-sufficient object. Not conjoined; layered. |
| 10 | **Comments restating code** | doesn't | Comment density is high but load-bearing (headers explain history and trade-offs, not what the code says). |
| 11 | **Vague names** | doesn't | No `Manager`, `Helper`, `Utils`, `Handler` classes. `parseAgentJson` is the vaguest name; subsumed by legacy deletion. |
| 12 | **Untyped generic containers** | doesn't | `ToolResult` and `DataSourceCallResult` type `result` as `unknown` on purpose (the MCP envelope carries adapter-specific `structuredContent`); call sites cast via `unwrap<T>()`. Honest, not lazy. |

**Severity-ordered top 3 fixes for THIS repo:**

1. **Delete the legacy tree.** `lib/agents/*-legacy.ts` (9 files). Port 2 test files to AptKit-backed classes. **Effort: 2-4 hours.** **Payoff:** ~1000 LOC gone, one obviousness landmine gone, one duplicated `AGENT_MODEL` constant gone. Highest ROI in the repo.

2. **Extract `BLOOMREACH_PENALTY_MS`.** One `export const` in a shared module (e.g. `lib/data-source/bloomreach-defaults.ts`). Import from `bloomreach-data-source.ts` and `connect.ts`. **Effort: 15 min.** **Payoff:** zero drift risk on the retry-window constant.

3. **One-line JSDoc on `makeAuthProvider`.** Trivial. **Effort: 2 min.** **Payoff:** the reader who opens `auth-providers/index.ts` sees "picks a provider by discriminant" without reading the switch first.

Nothing else fires with enough severity to spend a PR on. The rest of the audit is praise, honest small findings, and the pattern files below.
